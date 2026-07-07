import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import './AttendancePage.css';

// Returns the current month as a "YYYY-MM" string, e.g. "2026-06".
// This is the format an <input type="month"> uses.
const getCurrentMonth = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0'); // months are 0-based
  return `${year}-${month}`;
};

const AttendancePage = () => {
  const [employees, setEmployees] = useState([]);
  const [monthRecords, setMonthRecords] = useState([]); // attendance for the selected month
  const [month, setMonth] = useState(getCurrentMonth());
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [present, setPresent] = useState(true);
  const [workHours, setWorkHours] = useState('');
  const [overtime, setOvertime] = useState('');
  const [advancePayment, setAdvancePayment] = useState('');
  const [notes, setNotes] = useState('');
  const [editRecordId, setEditRecordId] = useState(null);

  // Load the employee list once when the page opens.
  useEffect(() => {
    fetchEmployees();
  }, []);

  // Re-fetch the register every time the selected month changes.
  useEffect(() => {
    fetchMonthAttendance(month);
  }, [month]);

  const fetchEmployees = async () => {
    try {
      const res = await axios.get('http://localhost:3000/api/employees');
      setEmployees(res.data.filter(e => e.isActive));
    } catch (err) {
      console.error('Failed to fetch employees:', err.message || err);
    }
  };

  // Fetch every attendance record that falls inside the chosen month.
  const fetchMonthAttendance = async (monthStr) => {
    if (!monthStr) return;
    const [year, mon] = monthStr.split('-').map(Number); // mon is 1-12
    // "Day 0 of the next month" == the last day of THIS month.
    // This automatically handles 28/29/30/31-day months and leap years.
    const daysInMonth = new Date(year, mon, 0).getDate();
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
    try {
      const res = await axios.get('http://localhost:3000/api/employee/attendance/range', {
        params: { startDate, endDate },
      });
      setMonthRecords(res.data);
    } catch (err) {
      console.error('Failed to load month attendance', err);
      setMonthRecords([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!employeeId || !date) {
      alert('Please select employee and date');
      return;
    }
    try {
      // An absent employee always saves as 0 hours and 0 overtime,
      // even though the form boxes are left blank.
      const finalWorkHours = present ? workHours : 0;
      const finalOvertime = present ? overtime : 0;
      
      if (editRecordId) {
        await axios.put(`http://localhost:3000/api/employee/attendance/${editRecordId}`, {
          present,
          workHours: finalWorkHours,
          overtime: finalOvertime,
          advancePayment,
          notes
        });
      } else {
        await axios.post('http://localhost:3000/api/employee/attendance', {
          employeeId, date, present,
          workHours: finalWorkHours,
          overtime: finalOvertime,
          advancePayment, notes
        });
      }
      await fetchMonthAttendance(month); // refresh the register
      setEditRecordId(null);
      setEmployeeId('');
      setDate('');
      setPresent(true);
      setWorkHours('');
      setOvertime('');
      setAdvancePayment('');
      setNotes('');
    } catch (err) {
      alert(err.response?.data?.message || 'Error marking attendance');
    }
  };

  const handleCellClick = (emp, day, rec) => {
    const fullDate = `${month}-${String(day).padStart(2, '0')}`;
    if (rec) {
      setEditRecordId(rec._id);
      setEmployeeId(emp._id);
      setDate(rec.date ? new Date(rec.date).toISOString().split('T')[0] : fullDate);
      setPresent(rec.present);
      setWorkHours(rec.workHours ?? '');
      setOvertime(rec.overtime ?? '');
      setAdvancePayment(rec.advancePayment ?? '');
      setNotes(rec.notes ?? '');
    } else {
      setEditRecordId(null);
      setEmployeeId(emp._id);
      setDate(fullDate);
      setPresent(true);
      setWorkHours('');
      setOvertime('');
      setAdvancePayment('');
      setNotes('');
    }
  };

  // ---- Build the register grid data ----
  const [year, mon] = month ? month.split('-').map(Number) : [0, 0];
  const daysInMonth = month ? new Date(year, mon, 0).getDate() : 0;
  // [1, 2, 3, ... daysInMonth] — the column headers.
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // A fast lookup: "employeeId-day" -> attendance record.
  // We read the day in UTC because dates are stored at UTC midnight,
  // which keeps the day correct no matter the viewer's timezone.
  const recordMap = {};
  monthRecords.forEach(rec => {
    const empId = rec.employee?._id;
    if (!empId || !rec.date) return;
    const day = new Date(rec.date).getUTCDate();
    recordMap[`${empId}-${day}`] = rec;
  });

  return (
    <div className="ep-container">
      <h2 className="ep-title">Mark Attendance</h2>
      <Link to="/admin" className="ep-btn ep-btn-primary" style={{ marginBottom: '16px', display: 'inline-block', textDecoration: 'none' }}>
        Back
      </Link>
      <form className="ep-form" onSubmit={handleSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '24px' }}>
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
          value={date}
          onChange={e => setDate(e.target.value)}
          className="ep-input"
        />
        <select
          value={present}
          onChange={e => {
            // Just switch the status. We DON'T write 0 into the boxes here,
            // so they stay blank (showing their placeholder). The 0 for an
            // absent employee is applied automatically on save instead.
            setPresent(e.target.value === 'true');
          }}
          className="ep-input"
        >
          <option value="true">Present</option>
          <option value="false">Absent</option>
        </select>
        <input
          type="number"
          value={workHours}
          onChange={e => {
            const raw = e.target.value;
            // Allow the box to be left truly empty instead of snapping to 0.
            const hours = raw === '' ? '' : Number(raw);
            setWorkHours(hours);
            // If the user enters 1 or more hours, they were clearly present:
            // flip the status back to Present automatically.
            if (hours >= 1) setPresent(true);
          }}
          className="ep-input"
          min={0}
          max={24}
          placeholder="Work Hours"
        />
        <input
          type="number"
          value={overtime}
          onChange={e => {
            const raw = e.target.value;
            setOvertime(raw === '' ? '' : Number(raw));
          }}
          className="ep-input ep-input-no-spinner"
          min={0}
          max={24}
          placeholder="Overtime"
        />
        <input
          type="number"
          value={advancePayment}
          onChange={e => setAdvancePayment(Number(e.target.value))}
          className="ep-input ep-input-no-spinner"
          min={0}
          placeholder="Advance Payment (₹)"
        />
        <input
          type="text"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="ep-input"
          placeholder="Notes"
        />
        <button type="submit" className="ep-btn ep-btn-primary" style={{ marginBottom: '8px' }}>
          {editRecordId ? 'Update' : 'Mark'}
        </button>
        {editRecordId && (
          <button
            type="button"
            className="ep-btn"
            style={{ marginBottom: '8px' }}
            onClick={() => {
              setEditRecordId(null);
              setEmployeeId('');
              setDate('');
              setPresent(true);
              setWorkHours('');
              setOvertime('');
              setAdvancePayment('');
              setNotes('');
            }}
          >
            Cancel
          </button>
        )}
      </form>

      <div className="att-register-header">
        <h3 className="ep-title" style={{ margin: 0 }}>Attendance Register</h3>
        <input
          type="month"
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="ep-input"
          style={{ width: 'auto' }}
        />
        <span className="att-legend">
          <span className="att-tick">✓</span> Present &nbsp;
          <span className="att-cross">✗</span> Absent &nbsp;
          <span className="att-none">–</span> No record &nbsp;
          <span style={{ color: '#1976d2', fontWeight: 'bold' }}>+</span> Overtime &nbsp;
          <span style={{ color: '#d32f2f', fontWeight: 'bold' }}>₹</span> Advance
        </span>
      </div>

      <div className="att-register-wrap">
        <table className="att-register">
          <thead>
            <tr>
              <th className="att-sticky-col">Employee</th>
              {days.map(d => (
                <th key={d}>{d}</th>
              ))}
              <th className="att-total-col">Total</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => {
              let presentCount = 0;
              let totalHrs = 0;
              // Build the day cells; accumulate this employee's monthly totals.
              const cells = days.map(d => {
                const rec = recordMap[`${emp._id}-${d}`];
                if (!rec) {
                  return <td key={d} className="att-cell-none" onClick={() => handleCellClick(emp, d, null)} style={{ cursor: 'pointer' }}>–</td>;
                }
                
                let cellTitle = undefined;
                if (rec.overtime > 0 || rec.advancePayment > 0 || rec.notes) {
                  cellTitle = `Overtime: ${rec.overtime || 0}h\nAdvance: ₹${rec.advancePayment || 0}\nNotes: ${rec.notes || 'N/A'}`;
                }

                if (rec.present) {
                  presentCount += 1;
                  totalHrs += rec.workHours || 0;
                  return (
                    <td key={d} className="att-cell-present" onClick={() => handleCellClick(emp, d, rec)} style={{ cursor: 'pointer' }} title={cellTitle}>
                      <span className="att-tick">✓</span>
                      <span className="att-hrs">
                        {rec.workHours}h
                        {rec.overtime > 0 && (
                          <span style={{ color: '#1976d2', marginLeft: '2px', fontWeight: 'bold' }}>+</span>
                        )}
                        {rec.advancePayment > 0 && (
                          <span style={{ color: '#d32f2f', marginLeft: '2px', fontWeight: 'bold' }}>₹</span>
                        )}
                      </span>
                    </td>
                  );
                }
                return <td key={d} className="att-cell-absent" onClick={() => handleCellClick(emp, d, rec)} style={{ cursor: 'pointer' }} title={cellTitle}><span className="att-cross">✗</span></td>;
              });
              return (
                <tr key={emp._id}>
                  <td className="att-sticky-col att-emp-name">{emp.name}</td>
                  {cells}
                  <td className="att-total-col">{presentCount}P<br />{totalHrs}h</td>
                </tr>
              );
            })}
            {employees.length === 0 && (
              <tr>
                <td colSpan={days.length + 2} style={{ textAlign: 'center', padding: '16px' }}>
                  No active employees found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AttendancePage;
