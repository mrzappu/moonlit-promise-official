const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

class DiscordLogger {
    constructor() {
        this.client = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers
            ] 
        });
        this.ready = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.messageQueue = [];
        this.initialized = false;
        
        this.channels = {
            login: process.env.DISCORD_LOGIN_CHANNEL,
            logout: process.env.DISCORD_LOGOUT_CHANNEL,
            register: process.env.DISCORD_REGISTER_CHANNEL,
            productView: process.env.DISCORD_PRODUCT_VIEW_CHANNEL,
            productAdd: process.env.DISCORD_PRODUCT_ADD_CHANNEL,
            productEdit: process.env.DISCORD_PRODUCT_EDIT_CHANNEL,
            productDelete: process.env.DISCORD_PRODUCT_DELETE_CHANNEL,
            cartAdd: process.env.DISCORD_CART_ADD_CHANNEL,
            cartRemove: process.env.DISCORD_CART_REMOVE_CHANNEL,
            cartView: process.env.DISCORD_CART_VIEW_CHANNEL,
            orderCreate: process.env.DISCORD_ORDER_CREATE_CHANNEL,
            orderUpdate: process.env.DISCORD_ORDER_UPDATE_CHANNEL,
            orderStatus: process.env.DISCORD_ORDER_STATUS_CHANNEL,
            orderComplete: process.env.DISCORD_ORDER_COMPLETE_CHANNEL,
            paymentInit: process.env.DISCORD_PAYMENT_INIT_CHANNEL,
            paymentSuccess: process.env.DISCORD_PAYMENT_SUCCESS_CHANNEL,
            paymentFailed: process.env.DISCORD_PAYMENT_FAILED_CHANNEL,
            paymentRefund: process.env.DISCORD_PAYMENT_REFUND_CHANNEL,
            adminLogin: process.env.DISCORD_ADMIN_LOGIN_CHANNEL,
            adminAction: process.env.DISCORD_ADMIN_ACTION_CHANNEL,
            adminProduct: process.env.DISCORD_ADMIN_PRODUCT_CHANNEL,
            error: process.env.DISCORD_ERROR_CHANNEL,
            system: process.env.DISCORD_SYSTEM_CHANNEL,
            backup: process.env.DISCORD_BACKUP_CHANNEL
        };

        // Validate channel IDs
        this.validateChannels();
        this.init();
    }

    validateChannels() {
        const requiredChannels = ['system', 'error', 'login', 'orderCreate', 'paymentInit'];
        const missing = requiredChannels.filter(ch => !this.channels[ch]);
        
        if (missing.length > 0) {
            console.warn(`⚠️ Missing Discord channel IDs: ${missing.join(', ')}`);
        }
    }

    async init() {
        if (this.initialized) return;
        this.initialized = true;

        try {
            console.log('🔄 Initializing Discord bot...');

            this.client.on('ready', () => {
                console.log(`✅ Discord bot connected as ${this.client.user.tag}`);
                console.log(`   Bot ID: ${this.client.user.id}`);
                console.log(`   Serving ${this.client.guilds.cache.size} guilds`);
                this.ready = true;
                this.reconnectAttempts = 0;
                this.processQueue();
                this.logSystem('Discord bot connected successfully', 'success');
            });

            this.client.on('error', (error) => {
                console.error('❌ Discord client error:', error.message);
                this.ready = false;
                this.logError(error, { location: 'discord_client' });
            });

            this.client.on('disconnect', () => {
                console.log('⚠️ Discord bot disconnected');
                this.ready = false;
                this.reconnect();
            });

            this.client.on('reconnecting', () => {
                console.log('🔄 Discord bot reconnecting...');
            });

            this.client.on('warn', (warning) => {
                console.warn('⚠️ Discord client warning:', warning);
            });

            if (!process.env.DISCORD_BOT_TOKEN) {
                throw new Error('DISCORD_BOT_TOKEN is not defined in environment variables');
            }

            console.log('🔑 Attempting to login with Discord bot token...');
            await this.client.login(process.env.DISCORD_BOT_TOKEN);
            
        } catch (error) {
            console.error('❌ Failed to connect Discord logger:', error.message);
            this.ready = false;
            this.initialized = false;
            
            // Specific error handling
            if (error.code === 'TokenInvalid') {
                console.error('   → The bot token is invalid. Please reset it in Discord Developer Portal');
                console.error('   → Go to: https://discord.com/developers/applications');
            } else if (error.code === 'DISALLOWED_INTENTS') {
                console.error('   → Missing required intents. Enable them in Discord Developer Portal:');
                console.error('   → Go to Bot section → Privileged Gateway Intents');
            } else if (error.code === 'TOKEN_INVALID') {
                console.error('   → Token is malformed. Check for extra spaces or quotes');
            }
            
            this.reconnect();
        }
    }

    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached. Giving up.');
            return;
        }

        this.reconnectAttempts++;
        console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay/1000}s...`);

        setTimeout(() => {
            this.initialized = false;
            this.init();
        }, this.reconnectDelay);

        // Exponential backoff
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
    }

    async processQueue() {
        if (this.messageQueue.length === 0) return;
        
        console.log(`📨 Processing ${this.messageQueue.length} queued messages...`);
        
        for (const queued of this.messageQueue) {
            try {
                await this.sendToChannel(queued.channelId, queued.message, queued.embed, queued.file);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit prevention
            } catch (error) {
                console.error('Error sending queued message:', error);
            }
        }
        
        this.messageQueue = [];
        console.log('✅ Queue processed');
    }

    async sendToChannel(channelId, message, embed = null, file = null) {
        // If bot not ready, queue the message
        if (!this.ready) {
            this.messageQueue.push({ channelId, message, embed, file });
            if (this.messageQueue.length === 1) {
                console.log('⏳ Bot initializing - messages will be sent when ready');
            }
            return;
        }

        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) {
                console.error(`❌ Channel ${channelId} not found`);
                return;
            }

            const content = {
                content: message.substring(0, 2000), // Discord message limit
                embeds: embed ? [embed] : []
            };
            
            if (file) {
                if (typeof file === 'string' && fs.existsSync(file)) {
                    content.files = [file];
                } else if (file?.path && fs.existsSync(file.path)) {
                    content.files = [file.path];
                }
            }
            
            await channel.send(content);
        } catch (error) {
            console.error(`❌ Failed to send to Discord:`, error.message);
            
            if (error.code === 10003) {
                console.error(`   → Channel ${channelId} does not exist`);
            } else if (error.code === 50001) {
                console.error(`   → Bot lacks permissions in channel ${channelId}`);
            } else if (error.code === 50013) {
                console.error(`   → Bot missing permissions`);
            }
        }
    }

    createEmbed(title, description, color = 0x00ff00, fields = [], footer = null) {
        const embed = new EmbedBuilder()
            .setTitle(title.substring(0, 256))
            .setDescription(description.substring(0, 4096))
            .setColor(color)
            .setTimestamp(new Date());
        
        if (fields && fields.length > 0) {
            embed.addFields(fields.map(f => ({
                name: f.name.substring(0, 256),
                value: f.value.substring(0, 1024),
                inline: f.inline || false
            })));
        }
        
        if (footer) {
            embed.setFooter({ text: footer.substring(0, 2048) });
        }
        
        return embed;
    }

    async logLogin(user, ip) {
        const embed = this.createEmbed(
            '🔐 User Login',
            `${user.username} logged in`,
            0x00ff00,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true },
                { name: 'IP', value: ip || 'Unknown', inline: true }
            ]
        );
        await this.sendToChannel(this.channels.login, '🔐 **Login Event**', embed);
    }

    async logLogout(user) {
        const embed = this.createEmbed(
            '🚪 User Logout',
            `${user.username} logged out`,
            0xffaa00,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.logout, '🚪 **Logout Event**', embed);
    }

    async logRegister(user) {
        const embed = this.createEmbed(
            '📝 New Registration',
            `New user: ${user.username}`,
            0x00ff00,
            [
                { name: 'Username', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true },
                { name: 'Joined', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.register, '📝 **New Registration**', embed);
    }

    async logProductView(user, product) {
        const embed = this.createEmbed(
            '👀 Product Viewed',
            `${user?.username || 'Guest'} viewed ${product.name}`,
            0x3498db,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Product ID', value: product.id.toString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productView, '👀 **Product View**', embed);
    }

    async logProductAdd(admin, product) {
        const embed = this.createEmbed(
            '➕ Product Added',
            `Added by ${admin.username}`,
            0x00ff00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Category', value: product.category, inline: true },
                { name: 'Admin', value: admin.username, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productAdd, '➕ **Product Added**', embed);
    }

    async logProductEdit(admin, product, changes) {
        const embed = this.createEmbed(
            '✏️ Product Edited',
            `Edited by ${admin.username}`,
            0xffaa00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Product ID', value: product.id.toString(), inline: true },
                { name: 'Changes', value: changes || 'Updated', inline: false }
            ]
        );
        await this.sendToChannel(this.channels.productEdit, '✏️ **Product Edited**', embed);
    }

    async logProductDelete(admin, product) {
        const embed = this.createEmbed(
            '🗑️ Product Deleted',
            `Deleted by ${admin.username}`,
            0xff0000,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Admin', value: admin.username, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productDelete, '🗑️ **Product Deleted**', embed);
    }

    async logCartAdd(user, product, quantity) {
        const embed = this.createEmbed(
            '🛒 Added to Cart',
            `${user.username} added item`,
            0x00ff00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Quantity', value: quantity.toString(), inline: true },
                { name: 'Total', value: `₹${product.price * quantity}`, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.cartAdd, '🛒 **Cart Addition**', embed);
    }

    async logCartRemove(user, product) {
        const embed = this.createEmbed(
            '❌ Removed from Cart',
            `${user.username} removed item`,
            0xffaa00,
            [
                { name: 'Product', value: product.name, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.cartRemove, '❌ **Cart Removal**', embed);
    }

    async logCartView(user) {
        const embed = this.createEmbed(
            '👀 Cart Viewed',
            `${user.username} viewed cart`,
            0x3498db
        );
        await this.sendToChannel(this.channels.cartView, '👀 **Cart View**', embed);
    }

    async logOrderCreate(user, order) {
        const embed = this.createEmbed(
            '📦 Order Created',
            `Order by ${user.username}`,
            0x00ff00,
            [
                { name: 'Order #', value: order.order_number, inline: true },
                { name: 'Amount', value: `₹${order.total_amount}`, inline: true },
                { name: 'Payment', value: order.payment_method, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderCreate, '📦 **New Order**', embed);
    }

    async logOrderUpdate(user, order, oldStatus, newStatus) {
        const embed = this.createEmbed(
            '🔄 Order Updated',
            `Order ${order.order_number}`,
            0xffaa00,
            [
                { name: 'Old Status', value: oldStatus, inline: true },
                { name: 'New Status', value: newStatus, inline: true },
                { name: 'Updated By', value: user.username, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderUpdate, '🔄 **Order Update**', embed);
    }

    async logOrderComplete(user, order) {
        const embed = this.createEmbed(
            '✅ Order Completed',
            `Order ${order.order_number} completed`,
            0x00ff00,
            [
                { name: 'Total', value: `₹${order.total_amount}`, inline: true },
                { name: 'User', value: user.username, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderComplete, '✅ **Order Complete**', embed);
    }

    async logPaymentInit(user, payment) {
        const embed = this.createEmbed(
            '💳 Payment Initiated',
            `By ${user.username}`,
            0xffaa00,
            [
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Method', value: payment.payment_method, inline: true },
                { name: 'Order ID', value: payment.order_id.toString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.paymentInit, '💳 **Payment Initiated**', embed);
    }

    async logPaymentSuccess(user, payment, proofUrl = null, upiTransactionId = null) {
        const fields = [
            { name: 'Amount', value: `₹${payment.amount}`, inline: true },
            { name: 'Method', value: payment.payment_method, inline: true },
            { name: 'User', value: user.username, inline: true }
        ];
        
        if (upiTransactionId) {
            fields.push({ name: 'UPI Txn ID', value: upiTransactionId, inline: false });
        }
        
        const embed = this.createEmbed(
            '✅ Payment Successful',
            `Payment completed by ${user.username}`,
            0x00ff00,
            fields
        );
        
        let message = `💰 **Payment Success**\n**User:** ${user.username}\n**Amount:** ₹${payment.amount}\n**Method:** ${payment.payment_method}`;
        
        if (proofUrl) {
            message += `\n**Proof:** ${proofUrl}`;
            try {
                const filePath = proofUrl.startsWith('/uploads/') ? 
                    path.join(__dirname, 'public', proofUrl) : null;
                
                if (filePath && fs.existsSync(filePath)) {
                    await this.sendToChannel(this.channels.paymentSuccess, message, embed, filePath);
                    return;
                }
            } catch (err) {
                console.error('Error attaching proof:', err);
            }
        }
        
        await this.sendToChannel(this.channels.paymentSuccess, message, embed);
    }

    async logPaymentFailed(user, payment, reason) {
        const embed = this.createEmbed(
            '❌ Payment Failed',
            `Failed for ${user.username}`,
            0xff0000,
            [
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Reason', value: reason, inline: false }
            ]
        );
        await this.sendToChannel(this.channels.paymentFailed, '❌ **Payment Failed**', embed);
    }

    async logPaymentRefund(admin, payment, reason) {
        const embed = this.createEmbed(
            '💸 Payment Refunded',
            `Refunded by ${admin.username}`,
            0xffaa00,
            [
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Reason', value: reason, inline: false }
            ]
        );
        await this.sendToChannel(this.channels.paymentRefund, '💸 **Payment Refunded**', embed);
    }

    async logAdminLogin(admin) {
        const embed = this.createEmbed(
            '👑 Admin Login',
            `${admin.username} logged in`,
            0xffaa00,
            [
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Discord ID', value: admin.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.adminLogin, '👑 **Admin Login**', embed);
    }

    async logAdminAction(admin, action, details) {
        const embed = this.createEmbed(
            '⚡ Admin Action',
            `Action by ${admin.username}`,
            0xffaa00,
            [
                { name: 'Action', value: action, inline: true },
                { name: 'Details', value: details, inline: false }
            ]
        );
        await this.sendToChannel(this.channels.adminAction, '⚡ **Admin Action**', embed);
    }

    async logError(error, context = {}) {
        console.error('Logging error to Discord:', error.message);
        
        const embed = this.createEmbed(
            '⚠️ System Error',
            error.message || 'Unknown error',
            0xff0000,
            [
                { name: 'Location', value: context.location || 'unknown', inline: false },
                { name: 'Stack', value: (error.stack || '').substring(0, 1000), inline: false },
                { name: 'Context', value: JSON.stringify(context).substring(0, 500), inline: false }
            ]
        );
        await this.sendToChannel(this.channels.error, '⚠️ **Error Alert**', embed);
    }

    async logSystem(message, type = 'info') {
        const colors = {
            info: 0x3498db,
            warning: 0xffaa00,
            error: 0xff0000,
            success: 0x00ff00
        };
        
        const embed = this.createEmbed(
            '🔧 System',
            message,
            colors[type] || 0x3498db
        );
        
        // Only queue if bot is initializing, otherwise send
        if (this.ready) {
            await this.sendToChannel(this.channels.system, '🔧 **System**', embed);
        } else {
            this.messageQueue.push({ 
                channelId: this.channels.system, 
                message: '🔧 **System**', 
                embed 
            });
        }
        
        console.log(`[System/${type}] ${message}`);
    }

    async logBackup(admin, filename, size) {
        const embed = this.createEmbed(
            '💾 Backup Created',
            `By ${admin.username}`,
            0x00ff00,
            [
                { name: 'File', value: filename, inline: true },
                { name: 'Size', value: `${(size / 1024).toFixed(2)} KB`, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.backup, '💾 **Backup Created**', embed);
    }

    // Get bot status
    getStatus() {
        return {
            ready: this.ready,
            user: this.client.user ? {
                tag: this.client.user.tag,
                id: this.client.user.id
            } : null,
            guilds: this.client.guilds.cache.size,
            reconnectAttempts: this.reconnectAttempts,
            queuedMessages: this.messageQueue.length
        };
    }
}

module.exports = new DiscordLogger();
