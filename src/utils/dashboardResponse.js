const buildDashboardResponse = ({
  totalEmployees,
  activeEmployees,
  totalCustomers,
  presentToday,
  attendanceMarked,
  monthSalary,
  monthAdvance,
  recentEmployees,
}) => ({
  totalEmployees,
  activeEmployees,
  totalCustomers,
  attendanceToday: presentToday,
  absentToday: Math.max(0, activeEmployees - presentToday),
  attendanceMarked,
  monthSalary: monthSalary.length > 0 ? monthSalary[0].total : 0,
  monthAdvance: monthAdvance.length > 0 ? monthAdvance[0].total : 0,
  recentEmployees,
});

module.exports = {
  buildDashboardResponse,
};
