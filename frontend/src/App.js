import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './App.css';
import './styles/auth.css';

// Authentication
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Auth from './pages/Auth';

// Components
import Navbar from './components/Navbar';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Receipts from './pages/Receipts';
import Matches from './pages/Matches';
import ImportTransactions from './pages/ImportTransactions';
import Exports from './pages/Exports';
import Profile from './pages/Profile';
import CompanySettings from './pages/CompanySettings';
import UserReceipts from './pages/UserReceipts';

function App() {
  return (
    <AuthProvider>
      <div className="App">
        <Routes>
          {/* Public Routes */}
          <Route path="/auth" element={<Auth />} />
          
          {/* Protected Routes */}
          <Route path="/*" element={
            <ProtectedRoute>
              <div className="authenticated-app">
                <Navbar />
                <main className="main-content">
                  <Routes>
                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/transactions" element={<Transactions />} />
                    <Route path="/receipts" element={<Receipts />} />
                    <Route path="/matches" element={<Matches />} />
                    <Route path="/import" element={<ImportTransactions />} />
                    <Route path="/exports" element={<Exports />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/company-settings" element={<CompanySettings />} />
                    <Route path="/team/:userId/receipts" element={<UserReceipts />} />
                  </Routes>
                </main>
              </div>
            </ProtectedRoute>
          } />
        </Routes>
        
        <ToastContainer
          position="top-right"
          autoClose={3000}
          hideProgressBar={false}
          newestOnTop={false}
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
        />
      </div>
    </AuthProvider>
  );
}

export default App; 