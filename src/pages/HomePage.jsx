import React from 'react';
import { Link } from 'react-router-dom';
import Navbar from './Navbar';
import Hero from './Hero';
import Products from './Products';
import './HomePage.css';

const HomePage = () => {
  return (
    <div className="landing-page">
      <Navbar />
      
      <main>
        <Hero />
        <Products />
      </main>

      <footer className="footer">
        <p>&copy; {new Date().getFullYear()} New Calcutta Handloom. All rights reserved.</p>
      </footer>
    </div>
  );
};

export default HomePage;