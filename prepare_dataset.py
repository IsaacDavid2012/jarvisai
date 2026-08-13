import json
import re

def parse_raw_chats(input_txt_path, output_jsonl_path):
    """
    Converts raw chat log lines into structured JSONL format for fine-tuning.
    Expected raw format:
      [Time] Speaker: Message
    """
    conversations = []
    current_chat = []
    
    with open(input_txt_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        # Example matcher for: "Isaac: Hey, check storage space"
        # Adjust regex based on your raw export format
        match = re.match(r'^([^:]+):\s*(.*)$', line)
        if match:
            speaker = match.group(1).strip()
            text = match.group(2).strip()
            
            # Map speakers to roles
            role = "user" if "boss" in speaker.lower() or "isaac" in speaker.lower() else "assistant"
            current_chat.append({"role": role, "content": text})
            
            # Group every 6-8 exchanges into a single training conversation block
            if len(current_chat) >= 8:
                conversations.append({
                    "messages": [
                        {"role": "system", "content": "You are JARVIS, Isaac's executive assistant."}
                    ] + current_chat
                })
                current_chat = []
                
    # Add any remaining turns
    if current_chat:
        conversations.append({
            "messages": [
                {"role": "system", "content": "You are JARVIS, Isaac's executive assistant."}
            ] + current_chat
        })

    # Write out as JSONL
    with open(output_jsonl_path, 'w', encoding='utf-8') as out:
        for conv in conversations:
            out.write(json.dumps(conv) + '\n')
            
    print(f"Dataset successfully compiled! Saved {len(conversations)} conversation rows to {output_jsonl_path}")

# Example Usage:
# parse_raw_chats("raw_secretary_transcripts.txt", "secretary_training_dataset.jsonl")
