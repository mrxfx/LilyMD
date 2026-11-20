const atlas = require('../lib/atlasApi');

module.exports = async function (sock, chatId, message, city) {
    try {
        const weather = await atlas.weather(city);
        const weatherText = `Weather in ${weather.city}${weather.country ? ', ' + weather.country : ''}: ${weather.description}. Temperature: ${weather.temp}°C (min ${weather.min}°C / max ${weather.max}°C), humidity ${weather.humidity}%.`;
        await sock.sendMessage(chatId, { text: weatherText }, { quoted: message });
    } catch (error) {
        console.error('Error fetching weather:', error);
        await sock.sendMessage(chatId, { text: 'Sorry, I could not fetch the weather right now.' }, { quoted: message } );
    }
};
