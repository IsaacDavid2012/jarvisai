#!/usr/bin/env python3
"""
JARVIS Outbound Call Dispatcher
Triggers Asterisk to ring Isaac's phone (PJSIP/101) directly via CLI.
"""

import sys
import os
import subprocess

def call_isaac(message_text="This is an automated reminder from JARVIS."):
    print(f"📞 Dispatching outbound call to Isaac (Extension 101): '{message_text}'")
    
    # Save the custom message to be spoken when Isaac answers
    msg_file = "/tmp/jarvis_outbound_msg.txt"
    try:
        with open(msg_file, "w") as f:
            f.write(message_text.strip())
    except Exception:
        pass

    # Load SUDO_PASSWORD from environment or .env file
    sudo_pass = os.getenv("SUDO_PASSWORD", "")
    if not sudo_pass and os.path.exists("/jarvis/code/jarvisai/.env"):
        with open("/jarvis/code/jarvisai/.env", "r") as f:
            for line in f:
                if line.startswith("SUDO_PASSWORD="):
                    sudo_pass = line.strip().split("=", 1)[1].strip("\"'")
                    break

    # Direct Asterisk origination (instant, no spooler permission overhead)
    originate_cmd = "asterisk -rx 'channel originate PJSIP/101 extension 100@from-internal'"
    if sudo_pass:
        cmd = f"echo {sudo_pass} | sudo -S {originate_cmd}"
    else:
        cmd = f"sudo -n {originate_cmd}"
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode == 0:
        print("✅ Outbound call dispatched to Asterisk. Phone ringing!")
    else:
        print(f"⚠️ Failed to originate call: {res.stderr}")

if __name__ == "__main__":
    msg = sys.argv[1] if len(sys.argv) > 1 else "Good day Isaac. This is a voice call notification from JARVIS."
    call_isaac(msg)
