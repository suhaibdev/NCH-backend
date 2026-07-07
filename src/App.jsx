import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import HomePage from './pages/HomePage';
import AdminPortalPage from './pages/AdminPortalPage';
import EmployeesPage from './pages/Employees/EmployeesPage';
import CustomersPage from './pages/Customer/CustomersPage';
import AttendancePage from './pages/Employees/Attendance';
import PayoutPage from './pages/Employees/PayoutPage';

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin" element={<AdminPortalPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/employees/attendance" element={<AttendancePage />} />
        <Route path="/employees/payout" element={<PayoutPage />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;