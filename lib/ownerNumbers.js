'use strict';
/**
 * Canonical list of Lily MD owners.
 *
 * The bot itself still reads settings.ownerNumber / data/owner.json; this module
 * exists so the web layer can answer "is this number an authorized owner?"
 * without loading the bot's settings (which needs dotenv + node_modules).
 */
const fs = require('fs');
const path = require('path');

// Primary + secondary owner (Requirements: 916033352400 / 916033271400)
const BUILT_IN_OWNERS = ['916033352400', '916033271400'];

function digits(value) {
    return String(value || '').replace(/[^0-9]/g, '');
}

function ownerNumbers() {
    const owners = new Set(BUILT_IN_OWNERS);

    try {
        const file = path.join(__dirname, '..', 'data', 'owner.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of Array.isArray(data) ? data : []) {
            const number = digits(entry);
            if (number) owners.add(number);
        }
    } catch {
        // data/owner.json is optional
    }

    for (const raw of [process.env.OWNER_NUMBER, process.env.SECONDARY_OWNERS, process.env.OWNERS]) {
        for (const part of String(raw || '').split(/[,;\s]+/)) {
            const number = digits(part);
            if (number.length >= 7) owners.add(number);
        }
    }

    return [...owners];
}

function isOwnerNumber(number) {
    return ownerNumbers().includes(digits(number));
}

module.exports = { ownerNumbers, isOwnerNumber, digits, BUILT_IN_OWNERS };
