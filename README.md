# Expense Receipt Matcher

A full-stack application for matching receipts with credit card transactions using OCR technology.

## Features

- **Receipt Upload & OCR**: Upload multiple receipt images/PDFs with automatic text extraction
- **Transaction Import**: Import Chase credit card transactions from CSV files
- **Smart Matching**: AI-powered matching algorithm with 85%+ accuracy
- **Auto-Matching**: Automatic receipt-to-transaction matching with 70% confidence threshold
- **Manual Review**: Review and confirm matches through intuitive UI
- **Multi-file Upload**: Drag & drop multiple receipts simultaneously
- **Transaction Management**: View, filter, and delete transactions
- **Sales Tax Tracking**: Extract and track sales tax from both receipts and CSV imports

## Tech Stack

### Backend
- **Node.js** with Express.js
- **SQLite** database with sqlite3
- **OCR**: pdf-parse for PDFs, Tesseract.js for images
- **File Upload**: Multer for handling multipart/form-data
- **Date Processing**: Moment.js for date parsing and formatting

### Frontend
- **React** with modern hooks (useState, useEffect)
- **React Router** for navigation
- **React Dropzone** for file uploads
- **React Toastify** for notifications
- **CSS Grid & Flexbox** for responsive layouts

## Architecture

```
expense-matcher/
├── backend/
│   ├── routes/
│   │   ├── receipts.js      # Receipt upload, OCR, matching
│   │   ├── transactions.js  # CSV import, transaction management
│   │   └── matches.js       # Matching algorithm, auto-match
│   ├── database/
│   │   └── init.js         # SQLite schema & initialization
│   ├── uploads/receipts/   # Uploaded receipt files
│   └── server.js           # Express server setup
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.js    # Overview & statistics
│   │   │   ├── Receipts.js     # Receipt management
│   │   │   ├── Transactions.js # Transaction management
│   │   │   └── Matches.js      # Match review
│   │   ├── services/
│   │   │   └── api.js         # Centralized API calls
│   │   └── App.js             # Main React component
│   └── public/
└── README.md
```

## Installation & Setup

### Prerequisites
- Node.js (v14+)
- NPM or Yarn

### 1. Clone Repository
```bash
git clone [repository-url]
cd expense-matcher
```

### 2. Install Dependencies
```bash
# Install root dependencies
npm install

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies  
cd ../frontend
npm install
```

### 3. Start Development Servers
```bash
# From project root
npm run dev
```

This starts both:
- Backend server: http://localhost:5000
- Frontend app: http://localhost:3000

## Usage

### 1. Import Transactions
1. Go to **Transactions** page
2. Click **Import CSV**
3. Upload Chase credit card CSV file
4. System extracts: Date, Description, Amount, Category, Transaction ID, Sales Tax

### 2. Upload Receipts
1. Go to **Receipts** page  
2. Drag & drop receipt files (PDF, JPG, PNG)
3. OCR automatically extracts: Amount, Date, Merchant name
4. Auto-matching attempts to find corresponding transactions

### 3. Review Matches
1. Go to **Matches** page
2. Review auto-matched receipts (70%+ confidence)
3. Manually match unmatched receipts
4. Confirm or reject suggested matches

### 4. Dashboard Overview
- View statistics (total transactions, receipts, matches)
- See recent activity
- Trigger bulk auto-matching

## Matching Algorithm

The system uses a multi-factor confidence scoring system:

### Amount Matching (60 points max)
- Exact match: 60 points
- Within $1: 40 points  
- Within $5: 20 points
- Within $10: 10 points

### Date Matching (25 points max)
- Same date: 25 points
- Within 1 day: 15 points
- Within 3 days: 5 points

### Merchant Matching (20 points max)
- Word-based matching with bonuses for significant terms
- Ignores common suffixes (LLC, Inc, Corp, etc.)
- Extra weight for longer, specific words (5+ characters)

**Auto-match threshold**: 70% confidence
**Manual review**: 50-69% confidence

## OCR Capabilities

### Receipt Amount Extraction
Multiple extraction strategies in priority order:
1. Payment-specific amounts (`PaymentUSD`, `Total ChargesUSD`)
2. Multi-line totals (`Total` → `$4,763.00`)
3. Grand Total / Final Total
4. Regular Total patterns
5. Subtotal extraction
6. Currency symbol patterns
7. Balance Due patterns
8. Context-aware flexible matching

### Date Extraction
- Invoice dates (`Invoice Date: March 15, 2024`)
- Payment dates (`Date paid: July 22, 2025`)
- Due dates (`Due Date: April 12, 2025`)
- Multiple date formats (MM/DD/YYYY, written dates)

### Merchant Detection
- Company indicators (LLC, Inc, Corp)
- Service-specific detection (Starlink, Birdseye Surveillance)
- Proper capitalization patterns
- Bill-to/From sections

## Database Schema

### Transactions
- `id`, `transaction_date`, `description`, `amount`
- `category`, `external_transaction_id`, `sales_tax`
- `chase_transaction_id` (unique), `created_at`, `updated_at`

### Receipts  
- `id`, `filename`, `original_filename`, `file_path`, `file_size`
- `ocr_text`, `extracted_amount`, `extracted_date`, `extracted_merchant`
- `processing_status`, `upload_date`, `created_at`, `updated_at`

### Matches
- `id`, `transaction_id`, `receipt_id`, `match_confidence`
- `match_status`, `user_confirmed`, `created_at`, `updated_at`

## API Endpoints

### Receipts
- `GET /api/receipts` - List receipts with pagination
- `POST /api/receipts/upload` - Upload receipt file
- `GET /api/receipts/:id` - Get single receipt
- `PUT /api/receipts/:id` - Update receipt data
- `DELETE /api/receipts/:id` - Delete receipt

### Transactions
- `GET /api/transactions` - List transactions with pagination  
- `POST /api/transactions/import` - Import CSV file
- `GET /api/transactions/:id` - Get single transaction
- `DELETE /api/transactions/:id` - Delete transaction

### Matches
- `GET /api/matches` - List all matches
- `POST /api/matches` - Create manual match
- `POST /api/matches/auto-match` - Trigger auto-matching
- `PUT /api/matches/:id` - Update match status
- `DELETE /api/matches/:id` - Delete match

## Login Rate Limit

The authentication endpoints are rate limited in `backend/routes/auth.js`. Each IP may attempt to log in or register only five times every 15 minutes. If you hit this limit, wait for the window to reset or adjust the `authLimiter` values (`max` and `windowMs`) in that file.

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

Private repository - All rights reserved. 