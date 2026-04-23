from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# In-memory storage
queue = []
avg_service_time = 5 # Default: 5 minutes

@app.route('/', methods=['GET'])
def index():
    return "Smart-Queue-Management-System API is running."

@app.route('/queue', methods=['GET'])
def get_queue():
    return jsonify({"queue": queue})

@app.route('/join', methods=['POST'])
def join_queue():
    data = request.json
    name = data.get('name')
    
    if not name:
        return jsonify({"error": "Name is required"}), 400
    
    if name in queue:
        # Move current user to end or just return position? 
        # Requirement says "Join Queue". If they are already in, we return their current position.
        position = queue.index(name) + 1
    else:
        queue.append(name)
        position = len(queue)
    
    waiting_time = (position - 1) * avg_service_time
    return jsonify({
        "position": position,
        "waiting_time": waiting_time,
        "avg_time": avg_service_time # Useful for client logic
    })

@app.route('/remove', methods=['POST'])
def remove_from_queue():
    data = request.json
    name = data.get('name')
    
    if name in queue:
        queue.remove(name)
        return jsonify({"message": f"{name} removed from queue"}), 200
    else:
        return jsonify({"error": "User not found in queue"}), 404

@app.route('/update-time', methods=['POST'])
def update_service_time():
    data = request.json
    new_avg_time = data.get('avg_time')
    
    if new_avg_time is not None:
        global avg_service_time
        avg_service_time = float(new_avg_time)
        return jsonify({"message": f"Average service time updated to {avg_service_time} minutes"}), 200
    else:
        return jsonify({"error": "Average time is required"}), 400

if __name__ == '__main__':
    app.run(port=5000)
