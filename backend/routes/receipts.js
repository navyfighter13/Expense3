const express = require('express');
const router = express.Router();
const db = require('../database/init');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Tesseract = require('tesseract.js');
const moment = require('moment');
const pdfParse = require('pdf-parse');
const { authenticateToken, getUserCompanies, requireCompanyAccess, addUserTracking } = require('../middleware/auth');

// Apply authentication middleware to all routes
router.use(authenticateToken);
router.use(getUserCompanies);
router.use(requireCompanyAccess);
router.use(addUserTracking);

// Import the matching algorithm from matches route
const findPotentialMatches = (receipt, transactions) => {
  const matches = [];
  
  if (!receipt.extracted_amount || !transactions || transactions.length === 0) {
    return matches;
  }

  transactions.forEach(transaction => {
    let confidence = 0;
    const reasons = [];

    // Amount matching (most important factor)
    const amountDiff = Math.abs(Math.abs(transaction.amount) - receipt.extracted_amount);
    if (amountDiff === 0) {
      confidence += 60;
      reasons.push('Exact amount match');
    } else if (amountDiff <= 1) {
      confidence += 40;
      reasons.push('Very close amount match');
    } else if (amountDiff <= 5) {
      confidence += 20;
      reasons.push('Close amount match');
    } else if (amountDiff <= 10) {
      confidence += 10;
      reasons.push('Approximate amount match');
    }

    // Date matching
    if (receipt.extracted_date && transaction.transaction_date) {
      const receiptDate = moment(receipt.extracted_date, ['MM/DD/YYYY', 'MM/DD/YY', 'M/D/YYYY', 'M/D/YY']);
      const transactionDate = moment(transaction.transaction_date);
      
      if (receiptDate.isValid() && transactionDate.isValid()) {
        const daysDiff = Math.abs(receiptDate.diff(transactionDate, 'days'));
        
        if (daysDiff === 0) {
          confidence += 25;
          reasons.push('Same date');
        } else if (daysDiff <= 1) {
          confidence += 15;
          reasons.push('Within 1 day');
        } else if (daysDiff <= 3) {
          confidence += 5;
          reasons.push('Within 3 days');
        }
      }
    }

    // Merchant/description matching
    if (receipt.extracted_merchant && transaction.description) {
      const merchantWords = receipt.extracted_merchant.toLowerCase().split(/\s+/);
      const descriptionLower = transaction.description.toLowerCase();
      
      let wordMatches = 0;
      let significantWordMatches = 0;
      
      merchantWords.forEach(word => {
        // Skip common words like "llc", "inc", "corp", etc.
        if (word.length > 2 && !['llc', 'inc', 'corp', 'ltd', 'company', 'co'].includes(word)) {
          if (descriptionLower.includes(word)) {
            wordMatches++;
            // Give extra credit for longer, more specific words
            if (word.length >= 5) {
              significantWordMatches++;
            }
          }
        }
      });
      
      if (wordMatches > 0) {
        // Base match percentage
        const baseMatchPercent = (wordMatches / merchantWords.filter(w => 
          w.length > 2 && !['llc', 'inc', 'corp', 'ltd', 'company', 'co'].includes(w)
        ).length) * 15;
        
        // Bonus for significant word matches (like "openai")
        const bonusPoints = significantWordMatches * 5;
        
        const totalMerchantPoints = Math.min(baseMatchPercent + bonusPoints, 20); // Cap at 20 points
        confidence += totalMerchantPoints;
        reasons.push(`Merchant keywords match (${wordMatches} words, ${significantWordMatches} significant)`);
      }
    }

    // Only include if confidence is above threshold
    if (confidence >= 10) {
      matches.push({
        transaction,
        confidence: Math.round(confidence),
        reasons,
        amountDiff
      });
    }
  });

  // Sort by confidence descending
  return matches.sort((a, b) => b.confidence - a.confidence);
};

// Function to trigger automatic matching for a specific receipt
const triggerAutoMatchForReceipt = (receiptId) => {
  console.log(`Triggering auto-match for receipt ${receiptId}`);
  
  // Get receipt details to determine company context
  db.get('SELECT * FROM receipts WHERE id = ?', [receiptId], (err, receipt) => {
    if (err || !receipt) {
      console.error('Error getting receipt for auto-match:', err);
      return;
    }

    // Get unmatched transactions belonging to the same company
    const transactionQuery = `
      SELECT t.* FROM transactions t
      WHERE t.id NOT IN (
        SELECT transaction_id FROM matches WHERE user_confirmed = 1
      ) AND t.company_id = ?
      ORDER BY t.transaction_date DESC
      LIMIT 100
    `;

    db.all(transactionQuery, [receipt.company_id], (err, transactions) => {
      if (err) {
        console.error('Error getting transactions for auto-match:', err);
        return;
      }

      const potentialMatches = findPotentialMatches(receipt, transactions);
      
      // Auto-match if confidence is high enough (70% threshold)
      if (potentialMatches.length > 0 && potentialMatches[0].confidence >= 70) {
        const bestMatch = potentialMatches[0];
        
        // Create the match
        db.run(`
          INSERT OR REPLACE INTO matches 
          (transaction_id, receipt_id, match_confidence, match_status, user_confirmed)
          VALUES (?, ?, ?, 'auto_matched', 0)
        `, [
          bestMatch.transaction.id,
          receiptId,
          bestMatch.confidence
        ], function(err) {
          if (err) {
            console.error('Error creating auto-match:', err);
          } else {
            console.log(`Auto-matched receipt ${receiptId} with transaction ${bestMatch.transaction.id} (confidence: ${bestMatch.confidence}%)`);
          }
        });
      } else {
        if (potentialMatches.length > 0) {
          const bestMatch = potentialMatches[0];
          console.log(`No high-confidence matches found for receipt ${receiptId}.`);
          console.log(`Best match: ${bestMatch.confidence}% - Transaction: "${bestMatch.transaction.description}" (${bestMatch.transaction.transaction_date}, $${Math.abs(bestMatch.transaction.amount)})`);
          console.log(`Match reasons: ${bestMatch.reasons.join(', ')}`);
        } else {
          console.log(`No matches found for receipt ${receiptId}`);
        }
      }
    });
  });
};

// Configure multer for receipt image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const receiptsDir = path.join(__dirname, '../uploads/receipts');
    if (!fs.existsSync(receiptsDir)) {
      fs.mkdirSync(receiptsDir, { recursive: true });
    }
    cb(null, receiptsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept image files and PDF files
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only image files and PDF files are allowed'));
    }
  },
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit (increased for PDFs)
  }
});

// OCR processing function
const processReceiptOCR = async (filePath, mimeType) => {
  try {
    let extractedText = '';

    if (mimeType === 'application/pdf') {
      // Process PDF file with direct text extraction
      console.log('Processing PDF file:', filePath);
      
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text;
      
      console.log(`Extracted ${extractedText.length} characters from PDF`);
      
      // Debug: Show first few lines of extracted text
      const debugLines = extractedText.split('\n').slice(0, 15).filter(line => line.trim());
      console.log('First 15 lines of extracted text:');
      debugLines.forEach((line, i) => console.log(`  ${i+1}: "${line.trim()}"`));
      
      // Also show lines containing dollar signs for debugging amount extraction
      const amountLines = extractedText.split('\n').filter(line => 
        line.includes('$') || /\d+\.\d{2}/.test(line) || 
        /payment|charge|amount|total/i.test(line)
      );
      if (amountLines.length > 0) {
        console.log('Lines with potential amounts:');
        amountLines.forEach((line, i) => console.log(`  ${i+1}: "${line.trim()}"`));
      }
      
      // If PDF has no extractable text (scanned document), fallback to OCR would go here
      // For now, we'll work with the extracted text
      if (!extractedText || extractedText.trim().length < 10) {
        console.log('PDF has minimal text, might be a scanned document');
        // You could add image-based OCR fallback here in the future
        extractedText = 'No extractable text found in PDF';
      }
    } else {
      // Process regular image file with OCR
      console.log('Processing image file:', filePath);
      const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
        logger: m => console.log(`Image OCR: ${m.status}`)
      });
      extractedText = text;
    }

    // Enhanced amount extraction with multiple strategies
    const amountBreakdown = {
      subtotal: null,
      tax: null,
      total: null,
      grandTotal: null
    };
    
    // Helper function to parse amounts correctly (handle both US and European formats)
    const parseAmount = (amountStr) => {
      // Remove currency symbols and extra spaces
      let cleaned = amountStr.replace(/[\$€£¥\s]/g, '');
      
      // Handle different decimal separators
      // If there's a comma followed by exactly 2 digits at the end, treat as decimal
      if (/,\d{2}$/.test(cleaned)) {
        cleaned = cleaned.replace(',', '.');
      } else {
        // Otherwise, remove commas (thousands separator)
        cleaned = cleaned.replace(/,/g, '');
      }
      
      return parseFloat(cleaned);
    };

    // Strategy 1: Look for Payment/Service specific amounts (for Starlink, etc.)
    // Handle both "Payment USD 202.55" and "PaymentUSD 202.55" formats
    const paymentRegex = /(?:payment|payment\s*amount|monthly\s*charge|service\s*charge|bill\s*amount|charge|amount|total\s*charges)(?:\s*USD\s*|\s*[\s:$€£¥]*)?([0-9,]+\.?\d{0,2})/gi;
    let paymentMatches = extractedText.match(paymentRegex);
    if (paymentMatches) {
      for (const match of paymentMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount > 0 && amount < 50000) {
          // For service invoices, treat payment amount as the main total
          amountBreakdown.total = amount;
          break;
        }
      }
    }

    // Strategy 1b: Specific USD format patterns (PaymentUSD 202.55, Total ChargesUSD 202.55)
    const usdRegex = /(?:payment|total\s*charges|subtotal|total\s*tax)USD\s*([0-9,]+\.?\d{0,2})/gi;
    let usdMatches = extractedText.match(usdRegex);
    if (usdMatches && !amountBreakdown.total) {
      for (const match of usdMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount > 0 && amount < 50000) {
          amountBreakdown.total = amount;
          break;
        }
      }
    }

    // Strategy 2: Handle multi-line totals FIRST (like Birdseye: "Total" on one line, "$4,763.00" on next)
    const textLines = extractedText.split('\n');
    for (let i = 0; i < textLines.length - 1; i++) {
      const currentLine = textLines[i].trim().toLowerCase();
      const nextLine = textLines[i + 1].trim();
      
      // If current line says "total" and next line has a dollar amount
      if (/^total\s*$/.test(currentLine)) {
        const nextLineAmount = nextLine.match(/^\$([0-9,]+\.?\d{0,2})$/);
        if (nextLineAmount) {
          const amount = parseAmount(nextLineAmount[1]);
          if (!isNaN(amount) && amount > 0 && amount < 50000) {
            amountBreakdown.total = amount;
            console.log(`Found multi-line total: "${currentLine}" -> "${nextLine}" = $${amount}`);
            break;
          }
        }
      }
    }

    // Strategy 3: Look for Grand Total / Final Total
    const grandTotalRegex = /(?:grand\s*total|final\s*total|total\s*amount|amount\s*due)[\s:$€£¥]*([0-9,]+\.?\d{0,2})/gi;
    let grandTotalMatches = extractedText.match(grandTotalRegex);
    if (grandTotalMatches) {
      for (const match of grandTotalMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount > 0 && amount < 50000) {
          amountBreakdown.grandTotal = amount;
          break;
        }
      }
    }

    // Strategy 4: Look for Total (not grand total) - only if no payment amount found  
    const totalRegex = /(?:^|\s|:)total[\s:$€£¥]*([0-9,]+\.?\d{0,2})/gi;
    let totalMatches = extractedText.match(totalRegex);
    if (totalMatches && !amountBreakdown.grandTotal && !amountBreakdown.total) {
      for (const match of totalMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount > 0 && amount < 50000) {
          amountBreakdown.total = amount;
          break;
        }
      }
    }



    // Strategy 5: Look for Subtotal
    const subtotalRegex = /(?:sub\s*total|subtotal)[\s:$€£¥]*([0-9,]+\.?\d{0,2})/gi;
    let subtotalMatches = extractedText.match(subtotalRegex);
    if (subtotalMatches) {
      for (const match of subtotalMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount > 0 && amount < 50000) {
          amountBreakdown.subtotal = amount;
          break;
        }
      }
    }

    // Strategy 6: Look for Tax
    const taxRegex = /(?:tax|vat|gst)[\s:$€£¥]*([0-9,]+\.?\d{0,2})/gi;
    let taxMatches = extractedText.match(taxRegex);
    if (taxMatches) {
      for (const match of taxMatches) {
        const numStr = match.replace(/^[^0-9,]*/, '');
        const amount = parseAmount(numStr);
        if (!isNaN(amount) && amount >= 0 && amount < 10000) {
          amountBreakdown.tax = amount;
          break;
        }
      }
    }

    // Strategy 7: Look for currency amounts in lines (fallback for service invoices)
    if (!amountBreakdown.total && !amountBreakdown.grandTotal) {
      const currencyRegex = /\$[\s]*([0-9,]+\.?\d{0,2})/g;
      let currencyMatches = extractedText.match(currencyRegex);
      if (currencyMatches) {
        // Look for the largest reasonable amount
        let bestFallbackAmount = null;
        for (const match of currencyMatches) {
          const numStr = match.replace(/^\$\s*/, '');
          const amount = parseAmount(numStr);
          if (!isNaN(amount) && amount > 0 && amount < 50000) {
            if (!bestFallbackAmount || amount > bestFallbackAmount) {
              bestFallbackAmount = amount;
            }
          }
        }
        if (bestFallbackAmount) {
          amountBreakdown.total = bestFallbackAmount;
        }
      }
    }

    // Strategy 8: Look for standalone amounts on their own lines (common in service invoices)
    if (!amountBreakdown.total && !amountBreakdown.grandTotal) {
      const lines = extractedText.split('\n');
      for (const line of lines) {
        // Look for lines that are primarily just an amount
        const standaloneAmountMatch = line.trim().match(/^[\$]?([0-9,]+\.?\d{2})$/);
        if (standaloneAmountMatch) {
          const amount = parseAmount(standaloneAmountMatch[1]);
          if (!isNaN(amount) && amount > 0 && amount < 50000) {
            amountBreakdown.total = amount;
            break;
          }
        }
      }
    }

    // Strategy 9: Look for specific invoice patterns (Balance Due, Amount, etc.)
    if (!amountBreakdown.total && !amountBreakdown.grandTotal) {
      const balanceRegex = /(?:balance\s*due|amount\s*owed|amount\s*payable|invoice\s*amount)[\s:$€£¥]*([0-9,]+\.?\d{0,2})/gi;
      let balanceMatches = extractedText.match(balanceRegex);
      if (balanceMatches) {
        for (const match of balanceMatches) {
          const numStr = match.replace(/^[^0-9,]*/, '');
          const amount = parseAmount(numStr);
          if (!isNaN(amount) && amount > 0 && amount < 50000) {
            amountBreakdown.total = amount;
            console.log(`Found balance due amount: $${amount} from "${match}"`);
            break;
          }
        }
      }
    }

    // Strategy 10: Look for amounts in billing/invoicing context with more flexible patterns
    if (!amountBreakdown.total && !amountBreakdown.grandTotal) {
      const lines = extractedText.split('\n');
      let foundInBillingSection = false;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Check if we're in a billing section
        if (/bill|invoice|charge|amount|payment/i.test(line)) {
          foundInBillingSection = true;
        }
        
        // If in billing section, look for amounts more aggressively
        if (foundInBillingSection) {
          const flexibleAmountMatch = line.match(/([0-9,]+\.?\d{2})/);
          if (flexibleAmountMatch) {
            const amount = parseAmount(flexibleAmountMatch[1]);
            if (!isNaN(amount) && amount > 1 && amount < 50000) {
              // Skip small amounts that are likely line numbers or quantities
              amountBreakdown.total = amount;
              console.log(`Found flexible amount: $${amount} from line "${line}"`);
              break;
            }
          }
        }
      }
    }

    // Determine the main amount (prefer grand total, then total, then subtotal)
    const extractedAmount = amountBreakdown.grandTotal || amountBreakdown.total || amountBreakdown.subtotal;
    let amountSource = '';
    if (amountBreakdown.grandTotal) {
      amountSource = `Grand Total: $${amountBreakdown.grandTotal}`;
    } else if (amountBreakdown.total) {
      amountSource = `Total: $${amountBreakdown.total}`;
    } else if (amountBreakdown.subtotal) {
      amountSource = `Subtotal: $${amountBreakdown.subtotal}`;
    }
    
    // Special debugging for Birdseye invoices
    if (extractedText.toLowerCase().includes('birdseye')) {
      console.log('=== BIRDSEYE INVOICE DEBUG ===');
      console.log('Amount breakdown:', amountBreakdown);
      console.log('Final extracted amount:', extractedAmount);
      console.log('Amount source:', amountSource);
      
      // Show all dollar amounts found in the text
      const allAmounts = extractedText.match(/\$[\s]*([0-9,]+\.?\d{0,2})/g);
      console.log('All dollar amounts found:', allAmounts);
      
      // Show lines containing numbers
      const numberLines = extractedText.split('\n').filter(line => /\d/.test(line));
      console.log('Lines with numbers:');
      numberLines.forEach((line, i) => console.log(`  ${i+1}: "${line.trim()}"`));
    }

    // Enhanced date extraction
    const dateStrategies = [
      // Strategy 1: Invoice dates with written format
      /(?:invoice\s*date|bill\s*date|date\s*paid)[\s:]*([a-z]+\s+\d{1,2},?\s+\d{4})/gi,
      // Strategy 2: Date paid concatenated format (Date paidJuly 22, 2025)
      /date\s*paid\s*([a-z]+\s+\d{1,2},?\s+\d{4})/gi,
      // Strategy 2b: Date paid with no space between paid and month (Date paidJuly 22, 2025)
      /date\s+paid([a-z]+\s+\d{1,2},?\s+\d{4})/gi,
      // Strategy 3: Invoice dates with numeric format
      /(?:invoice\s*date|bill\s*date|date)[\s:]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi,
      // Strategy 4: Due dates
      /(?:due\s*date|payment\s*due)[\s:]*([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi,
      // Strategy 5: General date patterns
      /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,
      // Strategy 6: Direct month name patterns (fallback)
      /((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4})/gi
    ];

    let extractedDate = null;
    let dateSource = '';
    
    // Look for dates in relevant lines
    const dateLines = extractedText.split('\n').filter(line => 
      /date|paid|invoice|due/i.test(line) && line.trim().length > 0
    );
    
          for (const dateRegex of dateStrategies) {
        const dateMatches = extractedText.match(dateRegex);
        if (dateMatches && dateMatches.length > 0) {
          for (const fullMatch of dateMatches) {
            // Try to extract numeric date first
            let dateMatch = fullMatch.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
            if (dateMatch) {
              extractedDate = dateMatch[1];
              dateSource = fullMatch;
              break;
            }
            
            // Try to extract written date format (e.g., "April 10, 2025")
            const writtenDateMatch = fullMatch.match(/([a-z]+\s+\d{1,2},?\s+\d{4})/i);
            if (writtenDateMatch) {
              // Convert written date to MM/DD/YYYY format
              try {
                const dateObj = new Date(writtenDateMatch[1]);
                if (!isNaN(dateObj.getTime())) {
                  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
                  const day = dateObj.getDate().toString().padStart(2, '0');
                  const year = dateObj.getFullYear();
                  extractedDate = `${month}/${day}/${year}`;
                  dateSource = fullMatch;
                  break;
                }
              } catch (e) {
                // Continue to next match if date parsing fails
              }
            }
          }
          if (extractedDate) break;
        }
      }

    // Enhanced merchant name extraction
    const lines = extractedText.split('\n').filter(line => line.trim().length > 0);
    
    // Words/phrases to exclude from merchant names
    const excludePatterns = [
      /^page\s+\d+/i,
      /^\d+$/,
      /^[\d\s\-()]+$/,
      /invoice|bill|receipt|statement/i,
      /total|subtotal|tax|amount|due/i,
      /^(to|from|attn|attention)[:]/i,
      /^(phone|tel|fax|email|address)/i,
      /^(thank you|thanks)/i,
      /^\W+$/
    ];

    // Look for merchant in different sections
    let potentialMerchant = null;
    let merchantSource = '';
    
    // Strategy 1: Look in first few lines for company names
    for (let i = 0; i < Math.min(8, lines.length); i++) {
      const line = lines[i].trim();
      
      if (line.length >= 3 && line.length <= 60 && 
          !excludePatterns.some(pattern => pattern.test(line)) &&
          !/^\d+[.,]\d+$/.test(line)) { // Not just a number
        
        // Prefer lines that look like company names
        if (/LLC|Inc|Corp|Company|Co\.|Ltd|LTD|Construction|Services|Group/i.test(line)) {
          potentialMerchant = line;
          merchantSource = `Line ${i+1}: "${line}" (company indicator found)`;
          break;
        }
        
        // Or lines with proper capitalization
        if (/^[A-Z][a-z]/.test(line) && !potentialMerchant) {
          potentialMerchant = line;
          merchantSource = `Line ${i+1}: "${line}" (proper capitalization)`;
        }
      }
    }
    
         // Strategy 2: Look for "Bill to" or "From" sections
     if (!potentialMerchant) {
       const billToMatch = extractedText.match(/(?:bill\s*to|from|vendor)[\s:]*\n([^\n]+)/i);
       if (billToMatch && billToMatch[1]) {
         const candidate = billToMatch[1].trim();
         if (candidate.length >= 3 && candidate.length <= 60) {
           potentialMerchant = candidate;
           merchantSource = `Bill to/From section: "${candidate}"`;
         }
       }
     }
     
     // Strategy 3: Look deeper in document for actual service provider
     if (!potentialMerchant || potentialMerchant.includes('Chasco')) {
       // Look for service-related terms that might indicate the real merchant
       const servicePatterns = [
         /(?:service\s*provider|provided\s*by|from|vendor)[\s:]*([^\n]+)/gi,
         /(?:starlink|spacex)/gi,
         /(?:internet|satellite|connectivity)/gi,
         /(?:birdseye|surveillance)/gi
       ];
       
       for (const pattern of servicePatterns) {
         const serviceMatches = extractedText.match(pattern);
         if (serviceMatches) {
           for (const match of serviceMatches) {
             if (/starlink|spacex/i.test(match)) {
               potentialMerchant = 'Starlink';
               merchantSource = `Service detection: "${match.trim()}"`;
               break;
             } else if (/birdseye|surveillance/i.test(match)) {
               potentialMerchant = 'Birdseye Surveillance LLC';
               merchantSource = `Service detection: "${match.trim()}"`;
               break;
             }
           }
           if (potentialMerchant === 'Starlink' || potentialMerchant === 'Birdseye Surveillance LLC') break;
         }
       }
     }
     
     // Special handling for specific merchant patterns
     if (extractedText.toLowerCase().includes('birdseye') && extractedText.toLowerCase().includes('surveillance')) {
       potentialMerchant = 'Birdseye Surveillance LLC';
       merchantSource = 'Document content detection: Birdseye Surveillance';
     }

         console.log(`Amount Breakdown:`, {
       subtotal: amountBreakdown.subtotal,
       tax: amountBreakdown.tax,
       total: amountBreakdown.total,
       grandTotal: amountBreakdown.grandTotal,
       finalAmount: extractedAmount
     });
     console.log(`Extracted data - Amount: ${extractedAmount} ${amountSource ? `from ${amountSource}` : '(not found)'}`);
     console.log(`Extracted data - Date: ${extractedDate || 'none'} ${dateSource ? `from "${dateSource}"` : ''}`);
     console.log(`Extracted data - Merchant: ${potentialMerchant || 'none'} ${merchantSource ? `from ${merchantSource}` : ''}`);

     return {
       text: extractedText,
       extractedAmount: extractedAmount,
       extractedDate: extractedDate,
       extractedMerchant: potentialMerchant || null,
       amountBreakdown: amountBreakdown
     };
  } catch (error) {
    console.error('OCR processing error:', error);
    throw error;
  }
};

// Get all receipts
router.get('/', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  // Build query with proper user/admin filtering
  let whereClause = 'WHERE r.company_id = ?';
  let queryParams = [req.companyId];
  let countParams = [req.companyId];

  // If user is not admin, only show their own receipts
  if (req.user.currentRole !== 'admin') {
    whereClause += ' AND r.created_by = ?';
    queryParams.push(req.user.id);
    countParams.push(req.user.id);
  }

  const query = `
    SELECT r.*, 
           COUNT(m.id) as match_count,
           GROUP_CONCAT(t.description) as matched_transactions
    FROM receipts r
    LEFT JOIN matches m ON r.id = m.receipt_id AND m.user_confirmed = 1
    LEFT JOIN transactions t ON m.transaction_id = t.id
    ${whereClause}
    GROUP BY r.id
    ORDER BY r.upload_date DESC
    LIMIT ? OFFSET ?
  `;

  // Add limit and offset to params
  queryParams.push(limit, offset);

  db.all(query, queryParams, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Count query with same filtering
    const countQuery = `SELECT COUNT(*) as total FROM receipts r ${whereClause}`;
    db.get(countQuery, countParams, (err, countRow) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.json({
        receipts: rows,
        pagination: {
          page,
          limit,
          total: countRow.total,
          pages: Math.ceil(countRow.total / limit)
        }
      });
    });
  });
});

// Get single receipt
router.get('/:id', (req, res) => {
  // Build query with proper user/admin filtering
  let whereClause = 'WHERE r.id = ? AND r.company_id = ?';
  let queryParams = [req.params.id, req.companyId];

  // If user is not admin, only show their own receipts
  if (req.user.currentRole !== 'admin') {
    whereClause += ' AND r.created_by = ?';
    queryParams.push(req.user.id);
  }

  const query = `
    SELECT r.*, 
           GROUP_CONCAT(t.description) as matched_transactions,
           GROUP_CONCAT(t.id) as transaction_ids
    FROM receipts r
    LEFT JOIN matches m ON r.id = m.receipt_id AND m.user_confirmed = 1
    LEFT JOIN transactions t ON m.transaction_id = t.id
    ${whereClause}
    GROUP BY r.id
  `;

  db.get(query, queryParams, (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    res.json(row);
  });
});

// Upload receipt
router.post('/upload', upload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No receipt file uploaded' });
  }

  const receiptData = {
    filename: req.file.filename,
    original_filename: req.file.originalname,
    file_path: req.file.path,
    file_size: req.file.size,
    processing_status: 'processing'
  };

  // Insert receipt record
  db.run(`
    INSERT INTO receipts (filename, original_filename, file_path, file_size, processing_status, company_id, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    receiptData.filename,
    receiptData.original_filename,
    receiptData.file_path,
    receiptData.file_size,
    receiptData.processing_status,
    req.companyId,
    req.userId,
    req.userId
  ], async function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const receiptId = this.lastID;

    // Process OCR in background
    try {
      const ocrResult = await processReceiptOCR(req.file.path, req.file.mimetype);
      
      // Update receipt with OCR results
      const breakdown = ocrResult.amountBreakdown || {};
      db.run(`
        UPDATE receipts 
        SET ocr_text = ?, extracted_amount = ?, extracted_date = ?, 
            extracted_merchant = ?, processing_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        ocrResult.text,
        ocrResult.extractedAmount,
        ocrResult.extractedDate,
        ocrResult.extractedMerchant,
        'completed',
        receiptId
      ], (err) => {
        if (err) {
          console.error('Error updating OCR results:', err);
        } else {
          // Log the breakdown for debugging
          console.log(`Stored receipt ${receiptId} with breakdown:`, {
            subtotal: breakdown.subtotal,
            tax: breakdown.tax,
            total: breakdown.total,
            grandTotal: breakdown.grandTotal,
            finalAmount: ocrResult.extractedAmount
          });
          
          // Trigger automatic matching for this receipt
          if (ocrResult.extractedAmount) {
            triggerAutoMatchForReceipt(receiptId);
          }
        }
      });

    } catch (error) {
      console.error('OCR processing failed:', error);
      
      // Update status to failed
      db.run(`
        UPDATE receipts 
        SET processing_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, ['failed', receiptId]);
    }

    res.json({
      message: 'Receipt uploaded successfully',
      receiptId: receiptId,
      filename: receiptData.filename,
      processing_status: 'processing'
    });
  });
});

// Update receipt
router.put('/:id', (req, res) => {
  const { extracted_amount, extracted_date, extracted_merchant } = req.body;
  
  const query = `
    UPDATE receipts 
    SET extracted_amount = ?, extracted_date = ?, extracted_merchant = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(query, [extracted_amount, extracted_date, extracted_merchant, req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    res.json({ message: 'Receipt updated successfully' });
  });
});

// Delete receipt
router.delete('/:id', (req, res) => {
  // First get the receipt to delete the file
  db.get('SELECT file_path FROM receipts WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    // Delete the file if it exists
    if (fs.existsSync(row.file_path)) {
      fs.unlinkSync(row.file_path);
    }

    // Delete from database
    db.run('DELETE FROM receipts WHERE id = ?', [req.params.id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: 'Receipt deleted successfully' });
    });
  });
});

// Get unmatched receipts
router.get('/unmatched/list', (req, res) => {
  // Build query with proper user/admin filtering
  let whereClause = 'WHERE r.company_id = ?';
  let queryParams = [req.companyId];

  // If user is not admin, only show their own receipts
  if (req.user.currentRole !== 'admin') {
    whereClause += ' AND r.created_by = ?';
    queryParams.push(req.user.id);
  }

  const query = `
    SELECT * FROM receipts r
    ${whereClause}
    AND r.id NOT IN (
      SELECT receipt_id FROM matches WHERE user_confirmed = 1
    )
    AND r.processing_status = 'completed'
    ORDER BY r.upload_date DESC
  `;

  db.all(query, queryParams, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router; 