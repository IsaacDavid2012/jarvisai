# train.py
# A complete script for training your secretary model using Unsloth on Google Colab or Kaggle.
# Unsloth is chosen because it runs 2x faster and fits easily on a free T4 GPU.

import os
from unsloth import FastLanguageModel
import torch
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset

# 1. Configuration
max_seq_length = 2048  # Supports context scaling
dtype = None           # None for auto detection (Float16/Bfloat16 depending on GPU)
load_in_4bit = True    # Use 4-bit quantization to fit within free GPU limits

# 2. Load Base Model and Fast Tokenizer
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/Llama-3.2-3B-Instruct", # Smartest 3B model for this task
    max_seq_length = max_seq_length,
    dtype = dtype,
    load_in_4bit = load_in_4bit,
)

# 3. Configure LoRA parameters
model = FastLanguageModel.get_peft_model(
    model,
    r = 16,            # Choose any number > 0. Suggested: 8, 16, 32, 64
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                      "gate_proj", "up_proj", "down_proj"],
    lora_alpha = 16,
    lora_dropout = 0,  # Optimized to 0 for Unsloth speedups
    bias = "none",     # Optimized to none
    use_gradient_checkpointing = "unsloth", # Saves VRAM during training
    random_state = 3407,
    use_rslora = False,
    loftq_config = None,
)

# 4. Load your dataset
# Expects 'jarvis_boss_secretary_5000_conversations.jsonl' in the same directory
dataset = load_dataset("json", data_files="jarvis_boss_secretary_5000_conversations.jsonl", split="train")

# 5. Format ChatML inputs
def format_chatml(examples):
    formatted = []
    for messages in examples['messages']:
        # Format conversation using standard chat templates (ChatML / Instruct format)
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        formatted.append(text)
    return {"text": formatted}

dataset = dataset.map(format_chatml, batched=True)

# 6. Initialize SFTTrainer
trainer = SFTTrainer(
    model = model,
    tokenizer = tokenizer,
    train_dataset = dataset,
    dataset_text_field = "text",
    max_seq_length = max_seq_length,
    dataset_num_proc = 2,
    packing = False, # Can speed up training for short sequences
    args = TrainingArguments(
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        warmup_steps = 5,
        max_steps = 120, # Increase steps (e.g. 500-1000) for a thorough full run
        learning_rate = 2e-4,
        fp16 = not torch.cuda.is_bf16_supported(),
        bf16 = torch.cuda.is_bf16_supported(),
        logging_steps = 1,
        optim = "adamw_8bit",
        weight_decay = 0.01,
        lr_scheduler_type = "linear",
        seed = 3407,
        output_dir = "outputs",
        save_strategy = "no",
    ),
)

# 7. Start the training loop
trainer_stats = trainer.train()

# 8. Save the LoRA Adapter Weights
model.save_pretrained("jarvis_lora_model")
tokenizer.save_pretrained("jarvis_lora_model")

# 9. Save as GGUF directly (For local Ollama)
# Choose "q4_k_m" (4-bit quantization) or "f16" (unquantized)
print("Saving model to GGUF format...")
model.save_pretrained_gguf("jarvis_secretary_q4", tokenizer, quantization_method = "q4_k_m")
print("Done! Download the jarvis_secretary_q4-unsloth.Q4_K_M.gguf file to your server.")
