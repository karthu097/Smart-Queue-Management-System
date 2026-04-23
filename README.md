# Smart Queue Management System

A modern, full-stack virtual queueing solution that allows users to join a queue remotely, track their real-time position, and estimate waiting times.

## 🚀 Features

- **Virtual Queueing**: Users can join the queue by entering their name.
- **Real-time Tracking**: Live updates of position and waiting time.
- **Service Estimation**: Wait time is calculated based on `(Position - 1) × Average Service Time`.
- **Proximity Alerts**: Automatic notification when the user's turn is coming soon (Position ≤ 2).
- **Admin Dashboard**:
  - View full queue list.
  - Remove users from the queue.
  - Configure average service time.
- **Modern UI**: Dark mode, glassmorphism, and responsive design for all devices.

## 🛠️ Technology Stack

- **Frontend**: Vanilla HTML5, CSS3 (Custom Design System), JavaScript (ES6+).
- **Backend**: Python, Flask, Flask-CORS.
- **Design**: Premium aesthetics with smooth transitions and animated backgrounds.

## 🏃 Running the Project

1. **Backend**:
   - Install dependencies: `pip install flask flask-cors`
   - Run server: `python smart_queue_api.py`
   - The API will be available at `http://127.0.0.1:5000`

2. **Frontend**:
   - Open `client/index.html` in a browser or serve using a tool like Vite/Live Server.

## 📡 API Endpoints

- `GET /queue`: Get the current list of users in the queue.
- `POST /join`: Join the queue (Body: `{ "name": "string" }`).
- `POST /remove`: Remove a user (Body: `{ "name": "string" }`).
- `POST /update-time`: Set avg service time (Body: `{ "avg_time": number }`).