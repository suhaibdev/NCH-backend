// File: client/src/pages/CustomersPage.js
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

import '../AdminCommon.css';

const CustomersPage = () => {
  const [customers, setCustomers] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [gst, setGst] = useState('');
  const [editId, setEditId] = useState(null);
  const [searchName, setSearchName] = useState('');
  const [searchGst, setSearchGst] = useState('');

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      const res = await axios.get('http://localhost:3000/api/customers');
      setCustomers(res.data);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

  const handleAddOrUpdate = async () => {
    try {
      if (editId) {
        if (!name || !email) {
          alert('Name and Email are required');
          return;
        }
        await axios.put(`http://localhost:3000/api/customers/${editId}`, {
          name, email, contactNumber, gst
        });
        alert('Customer updated successfully');
      } else {
        await axios.post('http://localhost:3000/api/customers', { 
          name, email, contactNumber, gst 
        });
      }
      setName('');
      setEmail('');
      setContactNumber('');
      setGst('');
      setEditId(null);
      fetchCustomers();
    } catch (error) {
      console.error('Error saving customer:', error);
      alert(`Failed to save customer: ${error.response?.data?.message || error.message}`);
    }
  };

  const handleDeleteCustomer = async (id) => {
    if (window.confirm('Are you sure?')) {
      try {
        await axios.delete(`http://localhost:3000/api/customers/${id}`);
        fetchCustomers();
        alert('Customer deleted successfully');
      } catch (error) {
        console.error('Error deleting customer:', error);
        alert(`Failed to delete customer: ${error.response?.data?.message || error.message}`);
      }
    }
  };

  const handleEdit = (customer) => {
    setEditId(customer._id);
    setName(customer.name);
    setEmail(customer.email);
    setContactNumber(customer.contactNumber);
    setGst(customer.gst);
  };

  // Filter logic for Name and GST Number
  const filteredCustomers = customers.filter(cust => {
    const matchName = cust.name?.toLowerCase().includes(searchName.toLowerCase());
    
    // GST might be undefined or null for some customers, so we handle that safely
    const custGst = cust.gst || '';
    const matchGst = custGst.toLowerCase().includes(searchGst.toLowerCase());
    
    return matchName && matchGst;
  });

  return (
    <div className="ep-container">
      <h2 className="ep-title">Customers</h2>
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="ep-input"
        />
        <input
          maxLength="15"
          value={gst}
          onChange={(e) => setGst(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="GST"
          className="ep-input"
        />
        <input
          type="tel"
          maxLength="10"
          value={contactNumber}
          onChange={(e) => setContactNumber(e.target.value.replace(/\D/g, ''))}
          placeholder="Contact Number"
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
              setEmail('');
              setContactNumber('');
              setGst('');
            }}
            className="ep-btn ep-btn-secondary"
            style={{ margin: 0 }}
          >
            Cancel
          </button>
        )}
      </div>

      {customers.length === 0 ? (
        <p style={{ marginTop: '24px', color: '#888' }}>No customers yet</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '8px', margin: '24px 0 16px', flexWrap: 'wrap' }}>
            <input
              value={searchName}
              onChange={(e) => setSearchName(e.target.value)}
              placeholder="Search by Name"
              className="ep-input"
            />
            <input
              value={searchGst}
              onChange={(e) => setSearchGst(e.target.value)}
              placeholder="Search by GST"
              className="ep-input"
            />
            <button 
              className="ep-btn ep-btn-primary" 
              onClick={() => { setSearchName(''); setSearchGst(''); }}
              style={{ margin: 0 }}
            >
              Clear Filters
            </button>
          </div>

          {filteredCustomers.length === 0 ? (
            <p style={{ color: '#888' }}>No matching customers found.</p>
          ) : (
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table className="ep-table">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Contact</th>
                    <th>GST</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((cust, idx) => (
                    <tr key={cust._id}>
                      <td>{idx + 1}</td>
                      <td>{cust.name}</td>
                      <td>{cust.email}</td>
                      <td>{cust.contactNumber}</td>
                      <td>{cust.gst}</td>
                      <td style={{ display: 'flex' }}>
                        <button 
                          onClick={() => handleEdit(cust)} 
                          className="ep-btn ep-btn-edit"
                        >
                          Edit
                        </button>
                        <button 
                          onClick={() => handleDeleteCustomer(cust._id)} 
                          className="ep-btn ep-btn-delete"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CustomersPage;