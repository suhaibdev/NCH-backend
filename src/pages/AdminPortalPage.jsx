import React from 'react';
import { Link } from 'react-router-dom';
import Navbar from './Navbar';
import './HomePage.css';

const AdminPortalPage = () => {
  return (
    <div className="landing-page">
      <Navbar />
      
      <main style={{ minHeight: 'calc(100vh - 140px)', display: 'flex', alignItems: 'center' }}>
        <section className="admin-portal" style={{ width: '100%', backgroundColor: 'transparent' }}>
          <div className="container">
            <h2 className="section-title">Employee & Admin Portal</h2>
            <div className="home-links">
              <Link to="/employees" className="home-link home-link-blue">Employees</Link>
              <Link to="/employees/attendance" className="home-link home-link-purple">Attendance</Link>
              <Link to="/customers" className="home-link home-link-green">Customers</Link>
              <Link to="/employees/payout" className="home-link home-link-green">Payouts</Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <p>&copy; {new Date().getFullYear()} New Calcutta Handloom. All rights reserved.</p>
      </footer>
    </div>
  );
};

export default AdminPortalPage;