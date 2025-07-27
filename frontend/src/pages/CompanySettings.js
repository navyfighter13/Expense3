import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../services/api';

const CompanySettings = () => {
  const { user, currentCompany } = useAuth();
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('company');
  
  const [companyData, setCompanyData] = useState({
    id: null,
    name: '',
    domain: '',
    planType: '',
    userCount: 0,
    transactionCount: 0,
    receiptCount: 0
  });

  const [companyForm, setCompanyForm] = useState({
    name: '',
    domain: ''
  });

  const [users, setUsers] = useState([]);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    role: 'user'
  });

  const loadCompanyDetails = useCallback(async () => {
    if (!currentCompany?.id) return;

    try {
      setLoading(true);
      const response = await api.get(`/companies/${currentCompany.id}`);
      const company = response.data.company;
      
      setCompanyData(company);
      setCompanyForm({
        name: company.name || '',
        domain: company.domain || ''
      });
    } catch (error) {
      console.error('Error loading company details:', error);
      toast.error('Failed to load company information');
    } finally {
      setLoading(false);
    }
  }, [currentCompany]);

  const loadCompanyUsers = useCallback(async () => {
    if (!currentCompany?.id) return;

    try {
      const response = await api.get(`/companies/${currentCompany.id}/users`);
      setUsers(response.data.users || []);
    } catch (error) {
      console.error('Error loading company users:', error);
      if (error.response?.status !== 403) { // Don't show error for permission issues
        toast.error('Failed to load company users');
      }
    }
  }, [currentCompany]);

  useEffect(() => {
    if (currentCompany) {
      loadCompanyDetails();
      loadCompanyUsers();
    }
  }, [currentCompany, loadCompanyDetails, loadCompanyUsers]);

  const handleCompanyChange = (e) => {
    const { name, value } = e.target;
    setCompanyForm(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleInviteChange = (e) => {
    const { name, value } = e.target;
    setInviteForm(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleCompanySubmit = async (e) => {
    e.preventDefault();
    
    if (!companyForm.name.trim()) {
      toast.error('Company name is required');
      return;
    }

    try {
      setLoading(true);
      await api.put(`/companies/${currentCompany.id}`, {
        name: companyForm.name.trim(),
        domain: companyForm.domain.trim() || null
      });

      toast.success('Company information updated successfully');
      await loadCompanyDetails();
    } catch (error) {
      console.error('Error updating company:', error);
      toast.error(error.response?.data?.error || 'Failed to update company information');
    } finally {
      setLoading(false);
    }
  };

  const handleInviteSubmit = async (e) => {
    e.preventDefault();
    
    if (!inviteForm.email.trim()) {
      toast.error('Email address is required');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteForm.email)) {
      toast.error('Please enter a valid email address');
      return;
    }

    try {
      setLoading(true);
      await api.post(`/companies/${currentCompany.id}/invite`, {
        email: inviteForm.email.trim(),
        role: inviteForm.role
      });

      toast.success(`Invitation sent to ${inviteForm.email}`);
      setInviteForm({ email: '', role: 'user' });
      await loadCompanyUsers();
    } catch (error) {
      console.error('Error inviting user:', error);
      toast.error(error.response?.data?.error || 'Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    if (userId === user.id) {
      toast.error('You cannot change your own role');
      return;
    }

    try {
      await api.put(`/companies/${currentCompany.id}/users/${userId}/role`, {
        role: newRole
      });

      toast.success('User role updated successfully');
      await loadCompanyUsers();
    } catch (error) {
      console.error('Error updating user role:', error);
      toast.error(error.response?.data?.error || 'Failed to update user role');
    }
  };

  const handleRemoveUser = async (userId, userEmail) => {
    if (userId === user.id) {
      toast.error('You cannot remove yourself from the company');
      return;
    }

    if (!window.confirm(`Are you sure you want to remove ${userEmail} from the company?`)) {
      return;
    }

    try {
      await api.delete(`/companies/${currentCompany.id}/users/${userId}`);
      toast.success('User removed from company');
      await loadCompanyUsers();
    } catch (error) {
      console.error('Error removing user:', error);
      toast.error(error.response?.data?.error || 'Failed to remove user');
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const getRoleBadgeClass = (role) => {
    switch (role) {
      case 'admin': return 'badge-danger';
      case 'manager': return 'badge-warning';
      case 'user': return 'badge-info';
      default: return 'badge-info';
    }
  };

  const canManageUsers = currentCompany?.role === 'admin' || currentCompany?.role === 'manager';
  const canInviteUsers = currentCompany?.role === 'admin';

  if (!currentCompany) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading company information...</p>
      </div>
    );
  }

  return (
    <div className="company-settings-page">
      <div className="page-header">
        <h1>🏢 Company Settings</h1>
        <p>Manage your company information and team members</p>
      </div>

      <div className="company-container">
        {/* Tab Navigation */}
        <div className="tab-navigation">
          <button 
            className={`tab-button ${activeTab === 'company' ? 'active' : ''}`}
            onClick={() => setActiveTab('company')}
          >
            🏢 Company Information
          </button>
          {canManageUsers && (
            <button 
              className={`tab-button ${activeTab === 'users' ? 'active' : ''}`}
              onClick={() => setActiveTab('users')}
            >
              👥 Team Members
            </button>
          )}
          {canInviteUsers && (
            <button 
              className={`tab-button ${activeTab === 'invite' ? 'active' : ''}`}
              onClick={() => setActiveTab('invite')}
            >
              ➕ Invite Users
            </button>
          )}
          <button 
            className={`tab-button ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            📊 Overview
          </button>
        </div>

        {/* Company Information Tab */}
        {activeTab === 'company' && (
          <div className="card">
            <div className="card-header">
              <h3>Company Information</h3>
              <p>Update your company details</p>
            </div>
            
            <form onSubmit={handleCompanySubmit} className="company-form">
              <div className="form-group">
                <label htmlFor="companyName">Company Name</label>
                <input
                  type="text"
                  id="companyName"
                  name="name"
                  value={companyForm.name}
                  onChange={handleCompanyChange}
                  required
                  disabled={loading || currentCompany?.role !== 'admin'}
                  className="form-input"
                />
                {currentCompany?.role !== 'admin' && (
                  <small className="text-gray">Only administrators can change the company name</small>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="companyDomain">Company Domain (Optional)</label>
                <input
                  type="text"
                  id="companyDomain"
                  name="domain"
                  value={companyForm.domain}
                  onChange={handleCompanyChange}
                  disabled={loading || currentCompany?.role !== 'admin'}
                  className="form-input"
                  placeholder="example.com"
                />
                <small className="text-gray">
                  Users with email addresses from this domain can join automatically
                </small>
              </div>

              <div className="form-group">
                <label>Plan Type</label>
                <input
                  type="text"
                  value={companyData.planType?.toUpperCase() || 'BASIC'}
                  disabled
                  className="form-input disabled"
                />
                <small className="text-gray">Contact support to upgrade your plan</small>
              </div>

              {currentCompany?.role === 'admin' && (
                <div className="form-actions">
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn btn-primary"
                  >
                    {loading ? (
                      <>
                        <span className="spinner"></span>
                        Updating...
                      </>
                    ) : (
                      'Update Company'
                    )}
                  </button>
                </div>
              )}
            </form>
          </div>
        )}

        {/* Team Members Tab */}
        {activeTab === 'users' && canManageUsers && (
          <div className="card">
            <div className="card-header">
              <h3>Team Members</h3>
              <p>Manage your company's team members and their roles</p>
            </div>
            
            <div className="users-table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th>Last Login</th>
                    <th>Receipts</th>
                    {currentCompany?.role === 'admin' && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.map(member => (
                    <tr key={member.id}>
                      <td>
                        <div className="user-info">
                          <strong>{member.firstName} {member.lastName}</strong>
                          <div className="text-sm text-gray">{member.email}</div>
                          {member.id === user.id && (
                            <span className="badge badge-info">You</span>
                          )}
                        </div>
                      </td>
                      <td>
                        {currentCompany?.role === 'admin' && member.id !== user.id ? (
                          <select
                            value={member.role}
                            onChange={(e) => handleRoleChange(member.id, e.target.value)}
                            className="form-select"
                          >
                            <option value="user">User</option>
                            <option value="manager">Manager</option>
                            <option value="admin">Admin</option>
                          </select>
                        ) : (
                          <span className={`badge ${getRoleBadgeClass(member.role)}`}>
                            {member.role?.charAt(0).toUpperCase() + member.role?.slice(1)}
                          </span>
                        )}
                      </td>
                      <td>{formatDate(member.joinedAt)}</td>
                      <td>{formatDate(member.lastLogin)}</td>
                      <td>
                        <Link to={`/team/${member.id}/receipts`} className="btn btn-sm">
                          View
                        </Link>
                      </td>
                      {currentCompany?.role === 'admin' && (
                        <td>
                          {member.id !== user.id && (
                            <button
                              onClick={() => handleRemoveUser(member.id, member.email)}
                              className="btn btn-danger btn-sm"
                              title="Remove user"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>

              {users.length === 0 && (
                <div className="text-center text-gray mt-3">
                  No team members found
                </div>
              )}
            </div>
          </div>
        )}

        {/* Invite Users Tab */}
        {activeTab === 'invite' && canInviteUsers && (
          <div className="card">
            <div className="card-header">
              <h3>Invite New User</h3>
              <p>Add new team members to your company</p>
            </div>
            
            <form onSubmit={handleInviteSubmit} className="invite-form">
              <div className="form-group">
                <label htmlFor="inviteEmail">Email Address</label>
                <input
                  type="email"
                  id="inviteEmail"
                  name="email"
                  value={inviteForm.email}
                  onChange={handleInviteChange}
                  required
                  disabled={loading}
                  className="form-input"
                  placeholder="user@example.com"
                />
                <small className="text-gray">
                  The user must already have an account to be invited
                </small>
              </div>

              <div className="form-group">
                <label htmlFor="inviteRole">Role</label>
                <select
                  id="inviteRole"
                  name="role"
                  value={inviteForm.role}
                  onChange={handleInviteChange}
                  disabled={loading}
                  className="form-select"
                >
                  <option value="user">User - Can view and manage their own data</option>
                  <option value="manager">Manager - Can manage team data and users</option>
                  <option value="admin">Admin - Full access to company settings</option>
                </select>
              </div>

              <div className="form-actions">
                <button
                  type="submit"
                  disabled={loading}
                  className="btn btn-primary"
                >
                  {loading ? (
                    <>
                      <span className="spinner"></span>
                      Sending Invitation...
                    </>
                  ) : (
                    'Send Invitation'
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="card">
            <div className="card-header">
              <h3>Company Overview</h3>
              <p>Summary of your company's activity and statistics</p>
            </div>
            
            <div className="overview-stats">
              <div className="stat-card">
                <div className="stat-icon">👥</div>
                <div className="stat-content">
                  <div className="stat-number">{companyData.userCount || 0}</div>
                  <div className="stat-label">Team Members</div>
                </div>
              </div>
              
              <div className="stat-card">
                <div className="stat-icon">💳</div>
                <div className="stat-content">
                  <div className="stat-number">{companyData.transactionCount || 0}</div>
                  <div className="stat-label">Transactions</div>
                </div>
              </div>
              
              <div className="stat-card">
                <div className="stat-icon">🧾</div>
                <div className="stat-content">
                  <div className="stat-number">{companyData.receiptCount || 0}</div>
                  <div className="stat-label">Receipts</div>
                </div>
              </div>
              
              <div className="stat-card">
                <div className="stat-icon">📊</div>
                <div className="stat-content">
                  <div className="stat-number">
                    {companyData.transactionCount > 0 
                      ? Math.round((companyData.receiptCount / companyData.transactionCount) * 100)
                      : 0}%
                  </div>
                  <div className="stat-label">Match Rate</div>
                </div>
              </div>
            </div>

            <div className="company-details">
              <h4>Company Details</h4>
              <div className="detail-grid">
                <div className="detail-item">
                  <div className="detail-label">Company ID</div>
                  <div className="detail-value">{companyData.id}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Plan Type</div>
                  <div className="detail-value">
                    <span className="badge badge-info">
                      {companyData.planType?.toUpperCase() || 'BASIC'}
                    </span>
                  </div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Created</div>
                  <div className="detail-value">{formatDate(companyData.createdAt)}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Last Updated</div>
                  <div className="detail-value">{formatDate(companyData.updatedAt)}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CompanySettings; 
