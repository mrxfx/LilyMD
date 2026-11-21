const settings = require('../settings');
const { channelInfo } = require('../lib/messageConfig');
const fs = require('fs');
const path = require('path');

async function helpCommand(sock, chatId, message) {
    const helpMessage = `
╔═══════════════════╗
   *🤖 ${settings.botName || 'Lily MD'}*  
   Version: *${settings.version || '3.0.0'}*
   by ${settings.botOwner || 'Rahul Haldar'}
╚═══════════════════╝

*Available Commands:*

╔═══════════════════╗
🌐 *General Commands*:
║ ➤ .help or .menu
║ ➤ .website
║ ➤ .ping
║ ➤ .alive
║ ➤ .tts <text>
║ ➤ .owner
║ ➤ .joke
║ ➤ .quote
║ ➤ .fact
║ ➤ .weather <city>
║ ➤ .news
║ ➤ .attp <text>
║ ➤ .lyrics <song_title>
║ ➤ .8ball <question>
║ ➤ .groupinfo
║ ➤ .staff or .admins 
║ ➤ .vv
║ ➤ .vv2
║ ➤ .trt <text> <lang>
║ ➤ .ss <link>
║ ➤ .jid
║ ➤ .url
╚═══════════════════╝ 

╔═══════════════════╗
👮‍♂️ *Admin Commands*:
║ ➤ .ban @user
║ ➤ .promote @user
║ ➤ .demote @user
║ ➤ .mute <minutes>
║ ➤ .unmute
║ ➤ .delete or .del
║ ➤ .kick @user
║ ➤ .warnings @user
║ ➤ .warn @user
║ ➤ .antilink
║ ➤ .antibadword
║ ➤ .clear
║ ➤ .tag <message>
║ ➤ .tagall
║ ➤ .tagnotadmin
║ ➤ .hidetag <message>
║ ➤ .chatbot
║ ➤ .resetlink
║ ➤ .antitag <on/off>
║ ➤ .welcome <on/off>
║ ➤ .goodbye <on/off>
║ ➤ .antibot <on/off/set/get>
║ ➤ .setgdesc <description>
║ ➤ .setgname <new name>
║ ➤ .setgpp (reply to image)
║ ➤ .groupstatus [caption/text]
╚═══════════════════╝

╔═══════════════════╗
🔒 *Owner Commands*:
║ ➤ .mode <public/private>
║ ➤ .clearsession
║ ➤ .antidelete
║ ➤ .cleartmp
║ ➤ .update
║ ➤ .settings
║ ➤ .setpp <reply to image>
║ ➤ .autoreact <on/off>
║ ➤ .autostatus <on/off>
║ ➤ .autostatus react <on/off>
║ ➤ .aistatusreaction <emoji>
║ ➤ .aistatusreaction reset
║ ➤ .savestatus [on/off]
║ ➤ .autotyping <on/off>
║ ➤ .autoread <on/off>
║ ➤ .aiutoreply <on/off>
║ ➤ .aiutoreply mode <private/group/all/off>
║ ➤ .aiutoreply cooldown <seconds>
║ ➤ .aiprovider (3 slots + order)
║ ➤ .aiprovider key/baseurl/model <slot> <value>
║ ➤ .aiprovider test <slot>
║ ➤ .aiprovider models <slot> [search]
║ ➤ .aipause <30m/1h/2h30m>
║ ➤ .airesume [number]
║ ➤ .aiquiet <on/off/23:00-07:00>
║ ➤ .aicontact <number> <on/off/never/tone/lang/delay>
║ ➤ .ainever <number/list/remove>
║ ➤ .aiguard <on/off/notify/handoff>
║ ➤ .aisetkey <sk-or-...>
║ ➤ .aisetmodel <model>
║ ➤ .aistyle <description>
║ ➤ .aimemory
║ ➤ .aimemory <number>
║ ➤ .aimemory export
║ ➤ .aimemory set <number> <key> <value>
║ ➤ .aimemory forget <number> <key>
║ ➤ .aimemory clear <number|all>
║ ➤ .aistatus
║ ➤ .dbstatus
║ ➤ .schedule
║ ➤ .schedule list
║ ➤ .schedule edit <id> <time|text|repeat> <value>
║ ➤ .schedule cancel <id>
║ ➤ .schedule delete <id>
║ ➤ .schedule history
║ ➤ .schedule status
║ ➤ .anticall <on/off>
║ ➤ .pmblocker <on/off/status>
║ ➤ .pmblocker setmsg <text>
║ ➤ .setmention <reply to msg>
║ ➤ .mention <on/off>
╚═══════════════════╝

╔═══════════════════╗
🎨 *Image/Sticker Commands*:
║ ➤ .blur <image>
║ ➤ .simage <reply to sticker>
║ ➤ .sticker <reply to image>
║ ➤ .removebg
║ ➤ .remini
║ ➤ .crop (reply sticker/image/video)
║ ➤ .tgsticker <Link>
║ ➤ .meme
║ ➤ .take <packname> 
║ ➤ .emojimix <emj1>+<emj2>
║ ➤ .igs <insta link>
║ ➤ .igsc <insta link>
╚═══════════════════╝  

╔═══════════════════╗
🖼️ *Pies Commands*:
║ ➤ .pies <country>
║ ➤ .china 
║ ➤ .indonesia 
║ ➤ .japan 
║ ➤ .korea 
║ ➤ .hijab
╚═══════════════════╝

╔═══════════════════╗
🎮 *Game Commands*:
║ ➤ .tictactoe @user
║ ➤ .hangman
║ ➤ .guess <letter>
║ ➤ .trivia
║ ➤ .answer <answer>
║ ➤ .truth
║ ➤ .dare
╚═══════════════════╝

╔═══════════════════╗
🤖 *AI Commands*:
║ ➤ .ai <question>
║ ➤ .gpt <question>
║ ➤ .gemini <question>
║ ➤ .imagine <prompt>
║ ➤ .flux <prompt>
║ ➤ .sora <prompt>
╚═══════════════════╝

╔═══════════════════╗
🎯 *Fun Commands*:
║ ➤ .compliment @user
║ ➤ .insult @user
║ ➤ .flirt 
║ ➤ .shayari
║ ➤ .goodnight
║ ➤ .roseday
║ ➤ .character @user
║ ➤ .wasted @user
║ ➤ .ship @user
║ ➤ .simp @user
║ ➤ .stupid @user [text]
╚═══════════════════╝

╔═══════════════════╗
🔤 *Textmaker*:
║ ➤ .metallic <text>
║ ➤ .ice <text>
║ ➤ .snow <text>
║ ➤ .impressive <text>
║ ➤ .matrix <text>
║ ➤ .light <text>
║ ➤ .neon <text>
║ ➤ .devil <text>
║ ➤ .purple <text>
║ ➤ .thunder <text>
║ ➤ .leaves <text>
║ ➤ .1917 <text>
║ ➤ .arena <text>
║ ➤ .hacker <text>
║ ➤ .sand <text>
║ ➤ .blackpink <text>
║ ➤ .glitch <text>
║ ➤ .fire <text>
╚═══════════════════╝

╔═══════════════════╗
📥 *Downloader*:
║ ➤ .play <song_name>
║ ➤ .song <song_name>
║ ➤ .dl <any media link> (TikTok, IG, FB, X, Pinterest, Threads, Spotify, SoundCloud, YouTube, Mega, MediaFire, Sfile, Videy)
║ ➤ .spotify <query>
║ ➤ .instagram <link>
║ ➤ .facebook <link>
║ ➤ .twitter <link>
║ ➤ .tiktok <link>
║ ➤ .video <song name>
║ ➤ .ytmp4 <Link>
╚═══════════════════╝

╔═══════════════════╗
🧩 *MISC*:
║ ➤ .heart
║ ➤ .horny
║ ➤ .circle
║ ➤ .lgbt
║ ➤ .lolice
║ ➤ .its-so-stupid
║ ➤ .namecard 
║ ➤ .oogway
║ ➤ .tweet
║ ➤ .ytcomment 
║ ➤ .comrade 
║ ➤ .gay 
║ ➤ .glass 
║ ➤ .jail 
║ ➤ .passed 
║ ➤ .triggered
╚═══════════════════╝

╔═══════════════════╗
🖼️ *ANIME*:
║ ➤ .nom 
║ ➤ .poke 
║ ➤ .cry 
║ ➤ .kiss 
║ ➤ .pat 
║ ➤ .hug 
║ ➤ .wink 
║ ➤ .facepalm 
║ ➤ .slap
║ ➤ .bonk
║ ➤ .bite
║ ➤ .cuddle
║ ➤ .dance
║ ➤ .handhold
║ ➤ .happy
║ ➤ .highfive
║ ➤ .lick
║ ➤ .pout
║ ➤ .punch
║ ➤ .shoot
║ ➤ .sleep
║ ➤ .smug
║ ➤ .thumbsup
║ ➤ .wave
║ ➤ .yeet
║ ➤ .blush
║ ➤ .cringe
╚═══════════════════╝

╔═══════════════════╗
💻 *Github Commands:*
║ ➤ .git
║ ➤ .github
║ ➤ .sc
║ ➤ .script
║ ➤ .repo
╚═══════════════════╝

╔═══════════════════╗
🌐 *Website*:
║ ➤ .website
╚═══════════════════╝

Website: ${settings.websiteUrl || 'not configured'}`;

    try {
        const imagePath = path.join(__dirname, '../assets/bot_image.jpg');
        
        if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            
            await sock.sendMessage(chatId, {
                image: imageBuffer,
                caption: helpMessage,
                ...channelInfo
            },{ quoted: message });
        } else {
            console.error('Bot image not found at:', imagePath);
            await sock.sendMessage(chatId, { 
                text: helpMessage,
                ...channelInfo
            });
        }
    } catch (error) {
        console.error('Error in help command:', error);
        await sock.sendMessage(chatId, { text: helpMessage });
    }
}

module.exports = helpCommand;