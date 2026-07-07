import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

import '../AdminCommon.css';
const EmployeesPage = () => {
  const [employees, setEmployees] = useState([]);
  const [name, setName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [baseDailySalary, setBaseDailySalary] = useState('');
  const [address, setAddress] = useState('');
  const [editId, setEditId] = useState(null);
  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      const res = await axios.get('https://nch-backend-63da.onrender.com/api/employees');
      setEmployees(res.data);
    } catch (err) {
      console.error('Failed to fetch employees:', err.message || err);
    }
  };

  const handleAddOrUpdate = async () => {
     if (editId) {
      await axios.put(`https://nch-backend-63da.onrender.com/api/employees/${editId}`, {
        name, contactNumber, baseDailySalary, address
      });
    } else {
      await axios.post('https://nch-backend-63da.onrender.com/api/employees', {
        name, contactNumber, baseDailySalary, address
      });
    }
    setName('');
    setContactNumber('');
    setBaseDailySalary('');
    fetchEmployees();
    setAddress('');
    setEditId(null);
    fetchEmployees();
  };
  const handleEdit = (emp) => {
    setEditId(emp._id);
    setName(emp.name);
    setContactNumber(.contactNumber || '');
    setBaseDailySalary(emp.baseDailySalary || '');
    setAddress(emp.address || '');
  };
  const handleDelete = (emp) => {
    if (window.confirm(`Are you sure you want to delete ${emp.name}?`)) {
      axios.delete(`https://nch-backend-63da.onrender.com/api/employees/${emp._id}`)
        .then(() => {
          fetchEmployees();
        })
        .catch(err => {
          console.error('Error deleting employee:', err);
        });
    }
  };

  return (
    <div className="ep-container">
      <h2 className="ep-title">Employees</h2>
      <Link to="/admin" className="ep-btn ep-btn-primary" style={{ marginBottom: '16px', display: 'inline-block', textDecoration: 'none' }}>
        Back
      </Link>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\b\w/g, char => char.toUpperCase()))}
          placeholder="Name"
          className="ep-input"
        />
        <input
          type="tel"
          maxLength="10"
          value={contactNumber}
          onChange={(e) => setContactNumber(e.target.value.replace(/\D/g, ''))}
          placeholder="Contact"
          className="ep-input"
        />
        <input
          value={baseDailySalary}
          onChange={(e) => setBaseDailySalary(e.target.value)}
          placeholder="Base salary"
          className="ep-input"
        />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Address"
          className="ep-input"
        />
        <button onClick={handleAddOrUpdate} className="ep-btn ep-btn-primary" style={{ margin: 0 }}>
          {editId ? 'Update' : 'Add'}
        </button>
        {editId && (
          <button
            onClick={() => {
              setEditId(null);
              setName('');
              setContactNumber('');
              setBaseDailySalary('');
              setAddress('');
            }}
            className="ep-btn ep-btn-secondary"
            style={{ margin: 0 }}
          >
            Cancel
          </button>
        )}
      </div>
      <div style={{ overflowX: 'auto', width: '100%', marginTop: '16px' }}>
        <table className="ep-table">
          <thead>
            <tr>
              <th>S.No</th>
              <th>Name</th>
              <th>Contact</th>
              <th>Base Salary</th>
              <th>Address</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.filter(emp => emp.isActive).map((emp,idx) => {
              return (
                <tr key={emp._id}>
                  <td>{idx + 1}</td>
                  <td>{emp.name}</td>
                  <td>{emp.contactNumber}</td>
                  <td>{emp.baseDailySalary}</td>
                  <td>{emp.address}</td>
                  <td style={{ display: 'flex'}}>
                    <button
                      onClick={() => handleEdit(emp)}
                      className="ep-btn ep-btn-edit"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(emp)}
                      className="ep-btn ep-btn-delete"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default EmployeesPage;