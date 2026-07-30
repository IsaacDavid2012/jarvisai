const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const CREDS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, "creds.json");

function getAuth() {
  if (!fs.existsSync(CREDS_PATH)) {
    return null;
  }
  try {
    return new google.auth.GoogleAuth({
      keyFile: CREDS_PATH,
      scopes: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar"
      ]
    });
  } catch (err) {
    console.error("Error creating Google Auth:", err.message);
    return null;
  }
}

async function getCalendarEvents(days = 7) {
  try {
    const auth = getAuth();
    if (!auth) {
      console.log("Calendar API skipped: creds.json not found or invalid.");
      return [];
    }

    const calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const later = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime"
    });

    const events = response.data.items || [];
    return events.map(event => ({
      id: event.id,
      summary: event.summary,
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      description: event.description || ""
    }));

  } catch (error) {
    console.error("Calendar error:", error.message);
    return [];
  }
}

async function scheduleEvent(eventData) {
  try {
    const auth = getAuth();
    if (!auth) {
      throw new Error("creds.json not found. Google Calendar credentials are required to schedule events.");
    }

    const calendar = google.calendar({ version: "v3", auth });
    const event = {
      summary: eventData.title,
      description: eventData.description || "",
      start: {
        dateTime: new Date(`${eventData.date}T${eventData.time}`),
        timeZone: "Asia/Kuala_Lumpur"
      },
      end: {
        dateTime: new Date(`${eventData.date}T${incrementTime(eventData.time)}`),
        timeZone: "Asia/Kuala_Lumpur"
      }
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event
    });

    return response.data;

  } catch (error) {
    console.error("Schedule error:", error.message);
    throw error;
  }
}

function incrementTime(time) {
  if (!time || !time.includes(":")) return "12:00";
  const [h, m] = time.split(":").map(Number);
  const newHour = (h + 1) % 24;
  return `${String(newHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

module.exports = { getCalendarEvents, scheduleEvent };
