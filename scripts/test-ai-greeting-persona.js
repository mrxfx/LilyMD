'use strict';

const assert = require('assert');
const {
    DEFAULT_GREETING,
    isPureGreeting,
    buildSystemPrompt,
    getConfig
} = require('../lib/aiAutoReply');
const { clarifyReply } = require('../lib/aiControls');
const { detectLanguage } = require('../lib/aiStyle');

let pass = 0;
let fail = 0;

function check(desc, cond) {
    if (cond) {
        pass++;
        console.log(`  ✓ ${desc}`);
    } else {
        fail++;
        console.error(`  ✗ ${desc}`);
    }
}

console.log('Testing AI Greeting & Persona:');

// 1. Exact default greeting verification
check(
    'Exact default greeting text matches requirement',
    DEFAULT_GREETING === 'Hey! I’m Rahul, Your Buddy From WebCraft Studio. What Can I Help With? 😊'
);

const config = getConfig();
check('Config defaultGreeting matches exact string', config.defaultGreeting === DEFAULT_GREETING);

// 2. Greeting detection test
check('Pure greeting "hi" detected', isPureGreeting('hi'));
check('Pure greeting "hello" detected', isPureGreeting('hello'));
check('Pure greeting "Hey" detected', isPureGreeting('Hey'));
check('Pure greeting "hey rahul" detected', isPureGreeting('hey rahul'));
check('Pure greeting "kemon acho" detected', isPureGreeting('kemon acho'));
check('Pure greeting "Hi dear!" detected', isPureGreeting('Hi dear!'));
check('Task with greeting "hi make a login page in HTML" is NOT pure greeting', !isPureGreeting('hi make a login page in HTML'));
check('Question "hey what is javascript?" is NOT pure greeting', !isPureGreeting('hey what is javascript?'));

// 3. System prompt verification
const prompt = buildSystemPrompt('Tommy');
check('System prompt includes Rahul persona from WebCraft Studio', prompt.includes('You are Rahul, Your Buddy From WebCraft Studio.'));
check('System prompt includes exact greeting instruction', prompt.includes('Hey! I’m Rahul, Your Buddy From WebCraft Studio. What Can I Help With? 😊'));
check('System prompt specifies not claiming to be a real human', prompt.includes('Do not claim to be a real human'));
check('System prompt specifies natural Benglish default', prompt.includes('Default to natural Benglish (Bengali written in English letters, mixed with English)'));
check('System prompt specifies language matching', prompt.includes('Reply in the language the user uses: if they write Bengali/Benglish, reply in Benglish; if they write English, reply in English'));
check('System prompt specifies neutral, natural, human-like tone', prompt.includes('neutral, natural, human-like tone: friendly and clear, but not overly excited, robotic, clingy, or full of emojis'));
check('System prompt specifies conciseness', prompt.includes('Keep replies concise and conversational'));

// 4. Clarify reply verification
check('Clarify reply defaults to natural Benglish', clarifyReply() === 'Ki bolcho, ektu clear kore bolo na?');
check('Clarify reply for English user query uses English', clarifyReply('auto', 'what does that mean?') === 'Could you please explain that a bit more clearly?');
check('Clarify reply has no excessive emojis or sarcastic tone', !clarifyReply().includes('😂') && !clarifyReply().includes('Arre, ab ki'));

// 5. Language detection verification
check('Detects Banglish "abr lagaichot ai" as benlish/bengali-roman', ['benlish', 'bengali-roman'].includes(detectLanguage('abr lagaichot ai')));
check('Detects Banglish "tarpa dece" as benlish/bengali-roman', ['benlish', 'bengali-roman'].includes(detectLanguage('tarpa dece')));
check('Detects Banglish "kita hoice" as benlish/bengali-roman', ['benlish', 'bengali-roman'].includes(detectLanguage('kita hoice')));
check('Detects English "can you help me with this?" as english', detectLanguage('can you help me with this?') === 'english');

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
