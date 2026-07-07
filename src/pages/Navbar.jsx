import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <header className="navbar">
      <div className="nav-container">
        <div className="nav-logo">
          <Link to="/" style={{ textDecoration: 'none' }}>
            <h2>NCH</h2>
          </Link>
        </div>
        <button className="mobile-menu-btn" onClick={() => setIsOpen(!isOpen)}>
          ☰
        </button>
        <nav className={`nav-links ${isOpen ? 'open' : ''}`}>
          <a href="/#hero" onClick={() => setIsOpen(false)}>Home</a>
          <a href="/#products" onClick={() => setIsOpen(false)}>Products</a>
          <Link to="/admin" onClick={() => setIsOpen(false)}>Admin Portal</Link>
        </nav>
      </div>
    </header>
  );
};

export default Navbar;