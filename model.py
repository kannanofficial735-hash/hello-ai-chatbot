# Small AI model code - from Colab notebook Small-AI-Model-flan-t5-small.ipynb
# https://colab.research.google.com/drive/1BuKgekKJml51uETs8hxIxY0JKO48O625
# In Colab, first run: !pip install -q transformers
#
# NOTE on transformers v5: the text2text-generation pipeline was removed in v5.
# Use AutoModelForSeq2SeqLM + generate() for google/flan-t5-small (see below).

from transformers import pipeline, AutoTokenizer, AutoModelForSeq2SeqLM

# --- Small model 1: distilbert (66M), sentiment / classification ---
print('Loading small model: distilbert-base-uncased (66M parameters)')
classifier = pipeline('sentiment-analysis', model='distilbert/distilbert-base-uncased-finetuned-sst-2-english')
print('Test 1 - hello:')
print(classifier('hello'))
print('Test 2 - greeting:')
print(classifier('Hello, I love this!'))
print('Test 3 - classification:')
print(classifier('I hate this, it is terrible.'))

# --- Small model 2: google/flan-t5-small (80M), text generation ---
print('Loading small model: google/flan-t5-small (80M parameters)')
tokenizer = AutoTokenizer.from_pretrained('google/flan-t5-small')
model = AutoModelForSeq2SeqLM.from_pretrained('google/flan-t5-small')
ask = lambda prompt: tokenizer.decode(model.generate(**tokenizer(prompt, return_tensors='pt'), max_new_tokens=50)[0], skip_special_tokens=True)
print('Test 1 - hello:')
print(ask('hello'))
print('Test 2 - greeting question:')
print(ask('What is the capital of India?'))
print('Test 3 - text generation / translation:')
print(ask('Translate English to French: Hello, how are you?'))
print('Test 4 - instruction prompt:')
print(ask('Answer this question: What is the capital of India?'))
print(ask('Say hello to me in a friendly way.'))
print(ask('Write one short sentence about the sun.'))
