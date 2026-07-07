import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import './PayoutPage.css';

const PayoutPage = () => {
  const [employees, setEmployees] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [preview, setPreview] = useState(null);
  const [deductions, setDeductions] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [message, setMessage] = useState('');
  const [searchName, setSearchName] = useState('');
  const [searchDate, setSearchDate] = useState('');
  const [selectedPayouts, setSelectedPayouts] = useState([]);

  useEffect(() => {
    fetchEmployees();
    fetchPayouts();
  }, []);

  const fetchEmployees = async () => {
    try {
      const res = await axios.get('https://nch-backend-63da.onrender.com/api/employees');
      setEmployees(res.data.filter(e => e.isActive));
    } catch (err) {
      console.error('Failed to fetch employees:', err.message || err);
    }
  };

  const fetchPayouts = async () => {
    try {
      const res = await axios.get('https://nch-backend-63da.onrender.com/api/employee/payout');
      setPayouts(res.data);
      setSelectedPayouts([]); // Clear selection when refetching
    } catch (err) {
      console.error('Failed to fetch payouts:', err.message || err);
    }
  };

  const handlePreview = async (e) => {
    e.preventDefault();
    setPreview(null);
    setMessage('');
    if (!employeeId || !startDate || !endDate) {
      setMessage('Please select employee and date range.');
      return;
    }
    try {
      const res = await axios.post('https://nch-backend-63da.onrender.com/api/employee/payout/preview', {
        employeeId, startDate, endDate
      });
      setPreview(res.data);
    } catch (err) {
      setMessage(err.response?.data?.message || 'Error calculating payout.');
    }
  };

  const handleCreatePayout = async () => {
    setMessage('');
    if (!preview) return;
    try {
      // The server recalculates all amounts from attendance itself,
      // so we only need to send the period, deductions and payment method.
      await axios.post('https://nch-backend-63da.onrender.com/api/employee/payout', {
        employeeId,
        startDate,
        endDate,
        deductions,
        paymentMethod
      });
      setMessage('Payout created successfully!');
      setPreview(null);
      setEmployeeId('');
      setStartDate('');
      setEndDate('');
      setDeductions(0);
      setPaymentMethod('cash');
      await fetchPayouts();
    } catch (err) {
      setMessage(err.response?.data?.message || 'Error creating payout.');
    }
  };

  const handleDeletePayout = async (id) => {
    if (window.confirm('Are you sure you want to delete this payout record?')) {
      try {
        await axios.delete(`https://nch-backend-63da.onrender.com/api/employee/payout/${id}`);
        await fetchPayouts();
      } catch (err) {
        alert(err.response?.data?.message || 'Error deleting payout.');
      }
    }
  };

  const handleBulkDelete = async () => {
    if (selectedPayouts.length === 0) return;
    if (window.confirm(`Are you sure you want to delete ${selectedPayouts.length} selected payout(s)?`)) {
      try {
        await Promise.all(
          selectedPayouts.map(id => axios.delete(`https://nch-backend-63da.onrender.com/api/employee/payout/${id}`))
        );
        await fetchPayouts();
      } catch (err) {
        alert(err.response?.data?.message || 'Error deleting payouts.');
      }
    }
  };

  // Filter logic extracted so we can use it for select all
  const filteredPayouts = payouts.filter(p => {
    let matchesName = true;
    let matchesDate = true;

    if (searchName) {
      matchesName = p.employee?.name?.toLowerCase().includes(searchName.toLowerCase());
    }

    if (searchDate) {
      const sDate = p.startDate ? p.startDate.split('T')[0] : '';
      const eDate = p.endDate ? p.endDate.split('T')[0] : '';
      const pDate = p.paidOn ? p.paidOn.split('T')[0] : '';
      
      matchesDate = (
        sDate === searchDate || 
        eDate === searchDate || 
        pDate === searchDate || 
        (searchDate >= sDate && searchDate <= eDate)
      );
    }

    return matchesName && matchesDate;
  });

  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedPayouts(filteredPayouts.map(p => p._id));
    } else {
      setSelectedPayouts([]);
    }
  };

  const handleSelect = (id) => {
    setSelectedPayouts(prev => 
      prev.includes(id) ? prev.filter(pId => pId !== id) : [...prev, id]
    );
  };

  return (
    <div className="ep-container">
      <h2 className="ep-title">Employee Payouts</h2>
      <Link to="/admin" className="ep-btn ep-btn-primary" style={{ marginBottom: '16px', display: 'inline-block', textDecoration: 'none' }}>
        Back
      </Link>
      <form className="payout-form" onSubmit={handlePreview} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'stretch' }}>
        <select
          value={employeeId}
          onChange={e => setEmployeeId(e.target.value)}
          className="ep-input"
        >
          <option value="">Select Employee</option>
          {employees.map(emp => (
            <option key={emp._id} value={emp._id}>
              {emp.name} ({emp.workType})
            </option>
          ))}
        </select>
        <input
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
          className="ep-input"
        />
        <input
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
          className="ep-input"
        />
        <button type="submit" className="ep-btn ep-btn-primary" style={{ margin: 0, padding: '0 16px', display: 'flex', alignItems: 'center' }}>Preview</button>
      </form>
      {message && <div className="payout-message">{message}</div>}
      {preview && (
        <div className="payout-preview">
          <h4>Payout Preview</h4>
          <div>Total Days Present: <b>{preview.totalDaysWorked}</b></div>
          <div>Total Hours Worked: <b>{preview.totalHoursWorked} h</b></div>
          <div>Hourly Rate: <b>₹{Number(preview.hourlyRate).toFixed(2)}</b> <small>(daily salary ÷ 8)</small></div>
          <div>Base Amount: <b>₹{Number(preview.totalAmount).toFixed(2)}</b></div>
          <div>Overtime Hours: <b>{preview.overtimeHours} h</b></div>
          <div>Overtime Amount: <b>₹{Number(preview.overtimeAmount).toFixed(2)}</b></div>
          {preview.totalAdvancePayment > 0 && (
            <div style={{ color: '#d32f2f', margin: '8px 0', padding: '8px', border: '1px solid #ffcdd2', borderRadius: '4px', backgroundColor: '#ffebee' }}>
              Advance Payments Taken: <b>₹{preview.totalAdvancePayment}</b>
              <div style={{ fontSize: '0.85rem', marginTop: '4px' }}>
                <i>Reminder: Please add this amount to deductions if not already settled.</i>
              </div>
            </div>
          )}
          <div>
            Deductions: <input
              type="number"
              value={deductions}
              min={0}
              onChange={e => setDeductions(Number(e.target.value))}
              className="ep-input"
              style={{ width: 80 }}
            />
          </div>
          <div>
            Payment Method:
            <select
              value={paymentMethod}
              onChange={e => setPaymentMethod(e.target.value)}
              className="ep-input"
              style={{ width: 120 }}
            >
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank Transfer</option>
            </select>
          </div>
          <div>
            <b>Gross Amount: ₹{(preview.grossAmount - deductions).toFixed(2)}</b>
          </div>
          <button className="ep-btn ep-btn-primary" onClick={handleCreatePayout} type="button">
            Create Payout
          </button>
        </div>
      )}

      <h3 className="ep-title">Payout Records</h3>
      
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input 
          type="text" 
          placeholder="Search by Employee Name" 
          value={searchName}
          onChange={(e) => setSearchName(e.target.value)}
          className="ep-input"
        />
        <input 
          type="date" 
          value={searchDate}
          onChange={(e) => setSearchDate(e.target.value)}
          className="ep-input"
        />
        <button 
          className="ep-btn ep-btn-primary" 
          onClick={() => { setSearchName(''); setSearchDate(''); }}
          style={{ margin: 0, padding: '0 16px', display: 'flex', alignItems: 'center', height: '100%' }}
        >
          Clear Filters
        </button>
        {selectedPayouts.length > 0 && (
          <button 
            className="ep-btn ep-btn-delete" 
            onClick={handleBulkDelete}
            style={{ margin: 0, padding: '0 16px', display: 'flex', alignItems: 'center', height: '100%' }}
          >
            Delete Selected ({selectedPayouts.length})
          </button>
        )}
      </div>

      <div style={{ overflowX: 'auto', width: '100%' }}>
        <table className="ep-table">
          <thead>
            <tr>
              <th style={{ width: '40px', textAlign: 'center' }}>
                <input 
                  type="checkbox" 
                  onChange={handleSelectAll} 
                  checked={filteredPayouts.length > 0 && selectedPayouts.length === filteredPayouts.length} 
                />
              </th>
              <th>S.No</th>
              <th>Employee</th>
              <th>Period</th>
              <th>Days</th>
              <th>Hours</th>
              <th>Base</th>
              <th>Overtime</th>
              <th>Deductions</th>
              <th>Total</th>
              <th>Actions</th>
              <th>Paid On</th>
              <th>Method</th>
            </tr>
          </thead>
          <tbody>
            {filteredPayouts.map((p, idx) => (
              <tr key={p._id}>
                <td style={{ textAlign: 'center' }}>
                  <input 
                    type="checkbox" 
                    checked={selectedPayouts.includes(p._id)} 
                    onChange={() => handleSelect(p._id)} 
                  />
                </td>
                <td>{idx + 1}</td>
                <td>{p.employee?.name}</td>
                <td>
                  {p.startDate ? new Date(p.startDate).toLocaleDateString() : ''} -{' '}
                  {p.endDate ? new Date(p.endDate).toLocaleDateString() : ''}
                </td>
                <td>{p.totalDaysWorked}</td>
                <td>{p.totalHoursWorked ?? 0}h</td>
                <td>₹{Number(p.totalAmount).toFixed(2)}</td>
                <td>
                  {p.overtimeHours}h<br />
                  ₹{p.overtimeAmount}
                </td>
                <td>₹{p.deductions}</td>
                <td>₹{(p.totalAmount + (p.overtimeAmount || 0) - (p.deductions || 0)).toFixed(2)}</td>
                <td style={{ display: 'flex', gap: '4px', flexDirection: 'column' }}>
                  <select
                    value={p.status}
                    onChange={async e => {
                      const newStatus = e.target.value;
                      try {
                        await axios.patch(`https://nch-backend-63da.onrender.com/api/employee/payout/${p._id}/status`, { status: newStatus });
                        await fetchPayouts();
                      } catch(err) {
                        alert(err.response?.data?.message || 'Error updating status.');
                      }
                    }}
                    className="ep-input"
                    style={{ width: '100px', padding: '4px' }}
                  >
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <button 
                    onClick={() => handleDeletePayout(p._id)}
                    className="ep-btn ep-btn-delete"
                    style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                  >
                    Delete
                  </button>
                </td>
                <td>{p.paidOn ? new Date(p.paidOn).toLocaleDateString() : ''}</td>
                <td>{p.paymentMethod}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default PayoutPage;