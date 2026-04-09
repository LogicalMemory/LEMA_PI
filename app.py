from flask import Flask,request
import subprocess
import json
import os

app = Flask(__name__)

wifi_device = "wlan0"
RESPONSE_FILE = os.path.join(os.path.dirname(__file__), "last_otp_response.json")

@app.route('/')
def index(msg="", color="red"):
    msg_html = f'<p style="color:{color}">{msg}</p>' if msg else ""
    dropdowndisplay = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Temporary Pin Entry!</title>
        </head>
        <body>
            <h1>Temporary Pin Entry</h1>{msg_html}
            <form action="/submit" method="post">
                <label for="ssid">Enter your temporary pin:</label>
                <p/>
                <label for="password">Pin: <input type="password" name="pin"/></label>
                <p/>
                <input type="submit" value="Connect">
            </form>
        </body>
        </html>
        """
    return dropdowndisplay


@app.route('/submit',methods=['POST'])
def submit():
    otp = request.form.get('pin', '').strip()

    res = subprocess.run(
        ["curl", "-s", "--max-time", "5", "-X", "PUT", "-w", "\n%{http_code}",
         f"https://lema.website:8000/api/users/otp_meter_systems/{otp}/"],
        capture_output=True, text=True
    )

    status_code = "000"
    email = None
    response_body = ""

    if res.returncode == 0:
        parts = res.stdout.rsplit("\n", 1)
        response_body = parts[0].strip() if parts else ""
        status_code = parts[1].strip() if len(parts) == 2 else "000"

    try:
        response_json = json.loads(response_body)
        with open(RESPONSE_FILE, "w", encoding="utf-8") as file:
            json.dump(response_json, file, indent=2)

        data = response_json.get('data', {})
        email = data.get('email')
    except json.JSONDecodeError:
        with open(RESPONSE_FILE, "w", encoding="utf-8") as file:
            json.dump(
                {
                    "success": False,
                    "message": "Invalid response format",
                    "status_code": status_code,
                    "raw_response": response_body,
                },
                file,
                indent=2,
            )

    responses = {
        "200": (f"Verified successfully for {email}", "green") if email else ("Verified successfully", "green"),
        "404": ("No user found for this PIN", "red"),
        "000": ("Backend unreachable", "red")
    }

    msg, color = responses.get(status_code, ("Verification failed", "red"))
    return index(msg, color)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=80)