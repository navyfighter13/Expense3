const express = require('express');
const router = express.Router();
const db = require('../database/init');
const moment = require('moment');
const { authenticateToken, getUserCompanies, requireCompanyAccess, addUserTracking } = require('../middleware/auth');

// Apply authentication to all routes
router.use(authenticateToken);
router.use(getUserCompanies);
router.use(requireCompanyAccess);
router.use(addUserTracking);

// Matching algorithm function
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

// Get all matches
router.get('/', (req, res) => {
  // If user is not admin, only show matches for their own transactions/receipts
  let whereClause = 'WHERE t.company_id = ? AND r.company_id = ?';
  let queryParams = [req.companyId, req.companyId];

  if (req.user.currentRole !== 'admin') {
    whereClause += ' AND (t.created_by = ? OR r.created_by = ?)';
    queryParams.push(req.user.id, req.user.id);
  }

  const query = `
    SELECT m.*, 
           t.transaction_date, t.description, t.amount as transaction_amount, t.category,
           r.original_filename, r.extracted_amount, r.extracted_date, r.extracted_merchant
    FROM matches m
    JOIN transactions t ON m.transaction_id = t.id
    JOIN receipts r ON m.receipt_id = r.id
    ${whereClause}
    ORDER BY m.created_at DESC
  `;

  db.all(query, queryParams, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get pending matches (not confirmed by user)
router.get('/pending', (req, res) => {
  // If user is not admin, only show pending matches for their own transactions/receipts
  let whereClause = 'WHERE m.user_confirmed = FALSE AND t.company_id = ? AND r.company_id = ?';
  let queryParams = [req.companyId, req.companyId];

  if (req.user.currentRole !== 'admin') {
    whereClause += ' AND (t.created_by = ? OR r.created_by = ?)';
    queryParams.push(req.user.id, req.user.id);
  }

  const query = `
    SELECT m.*, 
           t.transaction_date, t.description, t.amount as transaction_amount, t.category,
           r.original_filename, r.extracted_amount, r.extracted_date, r.extracted_merchant, r.file_path
    FROM matches m
    JOIN transactions t ON m.transaction_id = t.id
    JOIN receipts r ON m.receipt_id = r.id
    ${whereClause}
    ORDER BY m.match_confidence DESC, m.created_at DESC
  `;

  db.all(query, queryParams, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Find matches for a specific receipt
router.post('/find/:receiptId', (req, res) => {
  // Get receipt details
  db.get('SELECT * FROM receipts WHERE id = ? AND company_id = ?', [req.params.receiptId, req.companyId], (err, receipt) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    // Get unmatched transactions (transactions without confirmed matches)
    const transactionQuery = `
      SELECT t.* FROM transactions t
      WHERE t.id NOT IN (
        SELECT transaction_id FROM matches WHERE user_confirmed = 1
      ) AND t.company_id = ?
      ORDER BY t.transaction_date DESC
      LIMIT 100
    `;

    db.all(transactionQuery, [req.companyId], (err, transactions) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const potentialMatches = findPotentialMatches(receipt, transactions);
      
      res.json({
        receipt,
        potentialMatches: potentialMatches.slice(0, 10) // Top 10 matches
      });
    });
  });
});

// Create a match
router.post('/', (req, res) => {
  const { transaction_id, receipt_id, match_confidence, auto_confirm = false } = req.body;

  if (!transaction_id || !receipt_id) {
    return res.status(400).json({ error: 'transaction_id and receipt_id are required' });
  }

  const query = `
    INSERT OR REPLACE INTO matches 
    (transaction_id, receipt_id, match_confidence, match_status, user_confirmed)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(query, [
    transaction_id, 
    receipt_id, 
    match_confidence || 0, 
    auto_confirm ? 'confirmed' : 'pending',
    auto_confirm ? 1 : 0
  ], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.json({
      message: 'Match created successfully',
      matchId: this.lastID,
      confirmed: auto_confirm
    });
  });
});

// Confirm a match
router.put('/:id/confirm', (req, res) => {
  const query = `
    UPDATE matches 
    SET user_confirmed = 1, match_status = 'confirmed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(query, [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    res.json({ message: 'Match confirmed successfully' });
  });
});

// Reject a match
router.put('/:id/reject', (req, res) => {
  const query = `
    UPDATE matches 
    SET user_confirmed = 0, match_status = 'rejected', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(query, [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    res.json({ message: 'Match rejected successfully' });
  });
});

// Delete a match
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM matches WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    res.json({ message: 'Match deleted successfully' });
  });
});

// Auto-match all receipts
router.post('/auto-match', (req, res) => {
  const confidenceThreshold = req.body.threshold || 70;

  // Get all unmatched receipts
  const receiptQuery = `
    SELECT * FROM receipts r
    WHERE r.id NOT IN (
      SELECT receipt_id FROM matches WHERE user_confirmed = 1
    )
    AND r.processing_status = 'completed'
    AND r.extracted_amount IS NOT NULL
    AND r.company_id = ?
  `;

  db.all(receiptQuery, [req.companyId], (err, receipts) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Get unmatched transactions
    const transactionQuery = `
      SELECT t.* FROM transactions t
      WHERE t.id NOT IN (
        SELECT transaction_id FROM matches WHERE user_confirmed = 1
      )
      AND t.company_id = ?
    `;

    db.all(transactionQuery, [req.companyId], (err, transactions) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      let autoMatched = 0;
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO matches 
        (transaction_id, receipt_id, match_confidence, match_status, user_confirmed)
        VALUES (?, ?, ?, 'auto_matched', 0)
      `);

      receipts.forEach(receipt => {
        const matches = findPotentialMatches(receipt, transactions);
        
        // Auto-match if confidence is high enough
        if (matches.length > 0 && matches[0].confidence >= confidenceThreshold) {
          stmt.run([
            matches[0].transaction.id,
            receipt.id,
            matches[0].confidence
          ], (err) => {
            if (!err) {
              autoMatched++;
            }
          });
        }
      });

      stmt.finalize((err) => {
        if (err) {
          return res.status(500).json({ error: 'Error completing auto-match' });
        }
        
        res.json({
          message: 'Auto-matching completed',
          matched: autoMatched,
          totalReceipts: receipts.length,
          threshold: confidenceThreshold
        });
      });
    });
  });
});

// Get match statistics
router.get('/stats', (req, res) => {
  const queries = [
    'SELECT COUNT(*) as total_matches FROM matches',
    'SELECT COUNT(*) as confirmed_matches FROM matches WHERE user_confirmed = 1',
    'SELECT COUNT(*) as pending_matches FROM matches WHERE user_confirmed = 0',
    'SELECT COUNT(*) as unmatched_receipts FROM receipts WHERE id NOT IN (SELECT receipt_id FROM matches WHERE user_confirmed = 1)',
    'SELECT COUNT(*) as unmatched_transactions FROM transactions WHERE id NOT IN (SELECT transaction_id FROM matches WHERE user_confirmed = 1)'
  ];

  const stats = {};
  let completed = 0;

  queries.forEach((query, index) => {
    db.get(query, [], (err, row) => {
      if (!err) {
        const key = Object.keys(row)[0];
        stats[key] = row[key];
      }
      
      completed++;
      if (completed === queries.length) {
        res.json(stats);
      }
    });
  });
});

module.exports = router; 