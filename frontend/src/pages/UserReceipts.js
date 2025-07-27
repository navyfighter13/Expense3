import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../services/api';

const UserReceipts = () => {
  const { userId } = useParams();
  const { currentCompany } = useAuth();
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      if (!currentCompany?.id) return;
      setLoading(true);
      try {
        const res = await api.get(`/companies/${currentCompany.id}/users/${userId}/receipts`);
        setReceipts(res.data.receipts || []);
      } catch (err) {
        console.error('Error loading user receipts:', err);
        const message = err.response?.data?.error || 'Failed to load user receipts';
        toast.error(message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [userId, currentCompany]);

  if (loading) {
    return (
      <div className="flex-center" style={{ height: '50vh' }}>
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="user-receipts-page">
      <div className="page-header flex-between">
        <h1>User Receipts</h1>
        <Link to="/company-settings" className="btn btn-secondary">Back to Company</Link>
      </div>

      {receipts.length > 0 ? (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Upload Date</th>
                <th>Extracted Amount</th>
                <th>Merchant</th>
                <th>Matches</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map(r => (
                <tr key={r.id}>
                  <td>{r.original_filename}</td>
                  <td>{new Date(r.upload_date).toLocaleDateString()}</td>
                  <td>{r.extracted_amount ? `$${r.extracted_amount.toFixed(2)}` : '-'}</td>
                  <td>{r.extracted_merchant || '-'}</td>
                  <td>{r.match_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No receipts found for this user.</p>
      )}
    </div>
  );
};

export default UserReceipts;
