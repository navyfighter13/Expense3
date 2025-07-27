const express = require('express');
const db = require('../database/init');
const { authenticateToken, getUserCompanies, requireRole, requireCompanyAccess } = require('../middleware/auth');

const router = express.Router();

// Apply authentication to all routes
router.use(authenticateToken);
router.use(getUserCompanies);

// Get all companies for the current user
router.get('/', (req, res) => {
  res.json({
    companies: req.user.companies || [],
    currentCompany: req.user.currentCompany || null
  });
});

// Get specific company details (admin only)
router.get('/:id', requireCompanyAccess, requireRole('admin'), (req, res) => {
  const companyId = parseInt(req.params.id);

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  const query = `
    SELECT c.*, 
           COUNT(uc.user_id) as user_count,
           COUNT(t.id) as transaction_count,
           COUNT(r.id) as receipt_count
    FROM companies c
    LEFT JOIN user_companies uc ON c.id = uc.company_id AND uc.status = 'active'
    LEFT JOIN transactions t ON c.id = t.company_id
    LEFT JOIN receipts r ON c.id = r.company_id
    WHERE c.id = ?
    GROUP BY c.id
  `;

  db.get(query, [companyId], (err, company) => {
    if (err) {
      console.error('Error fetching company details:', err);
      return res.status(500).json({ error: 'Failed to fetch company details' });
    }

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        planType: company.plan_type,
        settings: company.settings ? JSON.parse(company.settings) : {},
        userCount: company.user_count,
        transactionCount: company.transaction_count,
        receiptCount: company.receipt_count,
        createdAt: company.created_at,
        updatedAt: company.updated_at
      }
    });
  });
});

// Update company details (admin only)
router.put('/:id', requireCompanyAccess, requireRole('admin'), (req, res) => {
  const companyId = parseInt(req.params.id);
  const { name, domain, settings } = req.body;

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Company name is required' });
  }

  const settingsJson = settings ? JSON.stringify(settings) : null;

  db.run(`
    UPDATE companies 
    SET name = ?, domain = ?, settings = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `, [name, domain, settingsJson, companyId], function(err) {
    if (err) {
      console.error('Error updating company:', err);
      return res.status(500).json({ error: 'Failed to update company' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ 
      message: 'Company updated successfully',
      company: { name, domain, settings }
    });
  });
});

// Get company users (admin/manager only)
router.get('/:id/users', requireCompanyAccess, requireRole('manager'), (req, res) => {
  const companyId = parseInt(req.params.id);

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  const query = `
    SELECT u.id, u.email, u.first_name, u.last_name, u.last_login, u.created_at,
           uc.role, uc.status, uc.created_at as joined_at
    FROM users u
    JOIN user_companies uc ON u.id = uc.user_id
    WHERE uc.company_id = ?
    ORDER BY uc.role DESC, u.first_name, u.last_name
  `;

  db.all(query, [companyId], (err, users) => {
    if (err) {
      console.error('Error fetching company users:', err);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    const formattedUsers = users.map(user => ({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      status: user.status,
      lastLogin: user.last_login,
      joinedAt: user.joined_at,
      memberSince: user.created_at
    }));

    res.json({ users: formattedUsers });
  });
});

// Invite user to company (admin only)
router.post('/:id/invite', requireCompanyAccess, requireRole('admin'), (req, res) => {
  const companyId = parseInt(req.params.id);
  const { email, role = 'user' } = req.body;

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const validRoles = ['user', 'manager', 'admin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  // Check if user exists
  db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()], (err, user) => {
    if (err) {
      console.error('Error checking user existence:', err);
      return res.status(500).json({ error: 'Invitation failed' });
    }

    if (!user) {
      return res.status(404).json({ 
        error: 'User not found. They need to register first.' 
      });
    }

    // Check if user is already in the company
    db.get('SELECT id FROM user_companies WHERE user_id = ? AND company_id = ?', 
      [user.id, companyId], (err, existingMembership) => {
        if (err) {
          console.error('Error checking existing membership:', err);
          return res.status(500).json({ error: 'Invitation failed' });
        }

        if (existingMembership) {
          return res.status(409).json({ error: 'User is already a member of this company' });
        }

        // Add user to company
        db.run(`
          INSERT INTO user_companies (user_id, company_id, role, status)
          VALUES (?, ?, ?, ?)
        `, [user.id, companyId, role, 'active'], function(err) {
          if (err) {
            console.error('Error adding user to company:', err);
            return res.status(500).json({ error: 'Invitation failed' });
          }

          res.status(201).json({
            message: 'User successfully added to company',
            membership: {
              userId: user.id,
              companyId: companyId,
              role: role,
              status: 'active'
            }
          });
        });
      });
  });
});

// Update user role in company (admin only)
router.put('/:id/users/:userId/role', requireCompanyAccess, requireRole('admin'), (req, res) => {
  const companyId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);
  const { role } = req.body;

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  // Prevent user from changing their own role
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  const validRoles = ['user', 'manager', 'admin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  db.run(`
    UPDATE user_companies 
    SET role = ? 
    WHERE user_id = ? AND company_id = ?
  `, [role, userId, companyId], function(err) {
    if (err) {
      console.error('Error updating user role:', err);
      return res.status(500).json({ error: 'Failed to update user role' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'User membership not found' });
    }

    res.json({ 
      message: 'User role updated successfully',
      role: role
    });
  });
});

// Remove user from company (admin only)
router.delete('/:id/users/:userId', requireCompanyAccess, requireRole('admin'), (req, res) => {
  const companyId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  // Prevent user from removing themselves
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot remove yourself from the company' });
  }

  // Check if this is the last admin
  db.get(`
    SELECT COUNT(*) as admin_count 
    FROM user_companies 
    WHERE company_id = ? AND role = 'admin' AND status = 'active'
  `, [companyId], (err, result) => {
    if (err) {
      console.error('Error checking admin count:', err);
      return res.status(500).json({ error: 'Failed to remove user' });
    }

    // Get user's role before removing
    db.get(`
      SELECT role FROM user_companies 
      WHERE user_id = ? AND company_id = ?
    `, [userId, companyId], (err, membership) => {
      if (err) {
        console.error('Error checking user role:', err);
        return res.status(500).json({ error: 'Failed to remove user' });
      }

      if (!membership) {
        return res.status(404).json({ error: 'User membership not found' });
      }

      // Prevent removing the last admin
      if (membership.role === 'admin' && result.admin_count <= 1) {
        return res.status(400).json({ 
          error: 'Cannot remove the last admin. Promote another user to admin first.' 
        });
      }

      // Remove user from company
      db.run(`
        DELETE FROM user_companies 
        WHERE user_id = ? AND company_id = ?
      `, [userId, companyId], function(err) {
        if (err) {
          console.error('Error removing user from company:', err);
          return res.status(500).json({ error: 'Failed to remove user' });
        }

        res.json({ message: 'User removed from company successfully' });
      });
    });
  });
});

// Get receipts uploaded by a specific user (admin/manager only)
router.get('/:id/users/:userId/receipts', requireCompanyAccess, requireRole('manager'), (req, res) => {
  const companyId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);

  // Verify user has access to this company
  if (req.user.currentCompany.id !== companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  const query = `
    SELECT r.*, COUNT(m.id) as match_count, GROUP_CONCAT(t.description) as matched_transactions
    FROM receipts r
    LEFT JOIN matches m ON r.id = m.receipt_id AND m.user_confirmed = 1
    LEFT JOIN transactions t ON m.transaction_id = t.id
    WHERE r.company_id = ? AND r.created_by = ?
    GROUP BY r.id
    ORDER BY r.upload_date DESC
  `;

  db.all(query, [companyId, userId], (err, rows) => {
    if (err) {
      console.error('Error fetching user receipts:', err);
      return res.status(500).json({ error: 'Failed to fetch user receipts' });
    }

    res.json({ receipts: rows });
  });
});

// Create new company (authenticated users)
router.post('/', (req, res) => {
  const { name, domain } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Company name is required' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // Create company
    db.run(`
      INSERT INTO companies (name, domain, plan_type)
      VALUES (?, ?, ?)
    `, [name, domain, 'basic'], function(err) {
      if (err) {
        console.error('Error creating company:', err);
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Failed to create company' });
      }

      const companyId = this.lastID;

      // Add current user as admin
      db.run(`
        INSERT INTO user_companies (user_id, company_id, role, status)
        VALUES (?, ?, ?, ?)
      `, [req.user.id, companyId, 'admin', 'active'], function(err) {
        if (err) {
          console.error('Error adding user to company:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to create company' });
        }

        db.run('COMMIT', (err) => {
          if (err) {
            console.error('Transaction commit error:', err);
            return res.status(500).json({ error: 'Failed to create company' });
          }

          res.status(201).json({
            message: 'Company created successfully',
            company: {
              id: companyId,
              name: name,
              domain: domain,
              role: 'admin'
            }
          });
        });
      });
    });
  });
});

module.exports = router; 