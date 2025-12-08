// Weekly Header Widget
// Computes and displays the header for a weekly review
// Usage: await dv.view("scripts/weekly-header", { startDate: page.start_date, weekNum: page.week_number })

const startDate = new Date(input.startDate);
const weekNum = input.weekNum;

const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 6);

const year = startDate.getFullYear();
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = monthNames[startDate.getMonth()];
const startDay = startDate.getDate();
const endDay = endDate.getDate();

dv.header(1, `Week ${weekNum} – ${monthName} ${startDay}-${endDay}, ${year}`);
