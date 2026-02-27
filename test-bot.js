require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

console.log('=== DISCORD BOT DIAGNOSTIC ===');
console.log('Node version:', process.version);
console.log('Token exists:', !!process.env.DISCORD_BOT_TOKEN);
console.log('Token length:', process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0);
console.log('Channel ID:', process.env.DISCORD_SYSTEM_CHANNEL);
console.log('==============================');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

client.on('ready', async () => {
    console.log('✅ SUCCESS! Bot is connected!');
    console.log(`Bot username: ${client.user.tag}`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Servers: ${client.guilds.cache.size}`);
    
    // Try to send a test message
    try {
        const channel = await client.channels.fetch(process.env.DISCORD_SYSTEM_CHANNEL);
        if (channel) {
            await channel.send('✅ Bot diagnostic successful!');
            console.log('✅ Test message sent to channel');
        } else {
            console.log('❌ Could not find channel');
        }
    } catch (err) {
        console.log('❌ Could not send message:', err.message);
    }
    
    process.exit(0);
});

client.on('error', (error) => {
    console.error('❌ Client error:', error.message);
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error('❌ Login failed:', error.message);
    if (error.code === 'TokenInvalid') {
        console.log('   → SOLUTION: Reset your bot token in Discord Developer Portal');
    } else if (error.code === 'DISALLOWED_INTENTS') {
        console.log('   → SOLUTION: Enable Privileged Gateway Intents in Discord Developer Portal');
    }
    process.exit(1);
});
