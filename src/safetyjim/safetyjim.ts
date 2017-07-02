import { Config } from '../config/config';
import * as winston from 'winston';
import * as Discord from 'discord.js';
import * as cron from 'cron';
import * as snekfetch from 'snekfetch';
import * as fs from 'fs';
import * as path from 'path';
import { BotDatabase } from '../database/database';
const Package = require('../../package.json');
// tslint:disable-next-line:max-line-length
const defaultWelcomeMessage = 'Welcome to $guild $user. You are in our holding room for $minute, please take this time to review our rules.';
const DiscordBotsGuildID = '110373943822540800';
const DiscordBotListGuildID = '264445053596991498';

type RegexRecords = { string: RegExp };
type Commands = { string: Command };

export interface Command {
    usage: string | string[];
    run: (bot: SafetyJim, msg: Discord.Message, args: string) => boolean;
}

export class SafetyJim {
    public client: Discord.Client;
    public bootTime: Date;
    private commandRegex = {} as RegexRecords;
    private prefixTestRegex = {} as RegexRecords;
    private commands = {} as Commands;
    private allowUsersCronJob;
    private unbanUserCronJob;
    private unmuteUserCronJob;

    constructor(public config: Config,
                public database: BotDatabase,
                public log: winston.LoggerInstance) {
        this.bootTime = new Date();
        this.loadCommands();
        log.info('Populating prefix regex dictionary.');
        this.database.getGuildPrefixes().then((prefixList) => {
            if (prefixList != null) {
                prefixList.map((record) => {
                    this.createRegexForGuild(record.GuildID, record.Prefix);
                });
            }
        });

        this.client = new Discord.Client({
            disableEveryone: true,
            disabledEvents: [
                'TYPING_START',
                'MESSAGE_UPDATE',
                'MESSAGE_REACTION_ADD',
                'MESSAGE_REACTION_REMOVE',
                'MESSAGE_REACTION_REMOVE_ALL',
                'USER_NOTE_UPDATE',
                'VOICE_SERVER_UPDATE',
                'RELATIONSHIP_ADD',
                'RELATIONSHIP_REMOVE',
            ],
        });
        this.client.on('ready', this.onReady());
        this.client.on('message', this.onMessage());
        this.client.on('guildCreate', this.onGuildCreate());
        this.client.on('guildDelete', this.onGuildDelete());
        this.client.on('guildMemberAdd', this.onGuildMemberAdd());
        this.client.on('guildMemberRemove', this.onGuildMemberRemove());

        this.client.login(config.discordToken);
    }

    public createRegexForGuild(guildID: string, prefix: string) {
        this.commandRegex[guildID] = new RegExp(`^${prefix}\\s+([^\\s]+)\\s*([^]*)\\s*`, 'i');
        this.prefixTestRegex[guildID] = new RegExp(`^${prefix}[\\s]*( .*)?$`, 'i');
    }

    public getUsageString(prefix: string, usage: string | string[]): string {
        if (typeof usage === 'string') {
            usage = usage.split(' - ');
            return `\`${prefix} ${usage[0]}\` - ${usage[1]}`;
        }

        return usage.map((cmdUsage) => {
            let u = cmdUsage.split(' - ');
            return `\`${prefix} ${u[0]}\` - ${u[1]}`;
        }).join('\n');
    }

    public getUsageStrings(prefix: string): string {
        return Object.keys(this.commands)
              .map((u) => this.getUsageString(prefix, this.commands[u].usage))
              .join('\n');
    }

    public failReact(msg: Discord.Message): void {
        msg.react('322698553980092417')
            .catch(() => {
            this.log.warn(`Could not react with fail emoji in guild "${msg.guild.name}"`);
        });
    }

    public successReact(msg: Discord.Message): void {
        msg.react('322698554294534144')
            .catch(() => {
                this.log.warn(`Could not react with success emoji in guild "${msg.guild.name}"`);
        });
    }

    public updateDiscordBotLists(): void {
        if (this.config.discordbotspwToken) {
            snekfetch
                .post(`https://bots.discord.pw/api/bots/${this.client.user.id}/stats`)
                .set('Authorization', this.config.discordbotspwToken)
                .send({ server_count: this.client.guilds.size })
                .catch((err) => {
                    if (!err.stack.includes('504')) {
                        this.log.error(`Could not update pw with error ${err.stack}`);
                    }
                });
        }

        if (this.config.discordbotsToken) {
            snekfetch
                .post(`https://discordbots.org/api/bots/${this.client.user.id}/stats`)
                .set('Authorization', this.config.discordbotsToken)
                .send({ server_count: this.client.guilds.size })
                .catch((err) => { this.log.error(`Could not update discordbots with error ${err.stack}`); });
        }
    }

    private onReady(): () => void {
        return (() => {
            this.log.info(`Client is ready, username: ${this.client.user.username}.`);
            this.client.generateInvite([
                'KICK_MEMBERS',
                'BAN_MEMBERS',
                'ADD_REACTIONS',
                'READ_MESSAGES',
                'SEND_MESSAGES',
                'MANAGE_MESSAGES',
                'MANAGE_ROLES',
            ]).then((link) => this.log.info(`Bot invite link: ${link}`));

            this.client.guilds.filter((guild) => this.isBotFarm(guild)).map((guild) => guild.leave());

            this.populateGuildConfigDatabase();
            this.populatePrefixDatabase();
            this.populateWelcomeMessageDatabase();
            this.updateDiscordBotLists();
            this.client.user.setGame(`-mod help | ${Package.version}`);

            this.allowUsersCronJob = new cron.CronJob({ cronTime: '*/10 * * * * *',
                                                    onTick: this.allowUsers.bind(this), start: true, context: this });
            this.unbanUserCronJob = new cron.CronJob({ cronTime: '*/20 * * * * *',
                                                    onTick: this.unbanUsers.bind(this), start: true, context: this });
            this.unmuteUserCronJob = new cron.CronJob({ cronTime: '*/20 * * * * *',
                                                    onTick: this.unmuteUsers.bind(this), start: true, context: this });
        });
    }

    private onMessage(): (msg: Discord.Message) => void {
        return ((msg: Discord.Message) => {
            if (msg.author.bot || msg.channel.type === 'dm') {
                return;
            }

            if (msg.isMentioned(this.client.user)) {
                if (msg.content.includes('help') ||
                    msg.content.includes('command')) {
                    this.database.getGuildPrefix(msg.guild)
                        .then((prefix) => {
                            this.successReact(msg);
                            msg.author.send({ embed: {
                                author: { name: 'Safety Jim - Commands', icon_url: this.client.user.avatarURL },
                                description: this.getUsageStrings(prefix),
                                color: 0x4286f4,
                            }});
                        });
                    return;
                } else if (msg.content.includes('prefix')) {
                    this.database.getGuildPrefix(msg.guild)
                        .then((prefix) => {
                            this.successReact(msg);
                            msg.author.send({ embed: {
                                author: { name: 'Safety Jim - Prefix', icon_url: this.client.user.avatarURL },
                                description: `"${msg.guild.name}"s prefix is: ${prefix}`,
                                color: 0x4286f4,
                            }});
                        });
                    return;
                }
            }

            let testRegex: RegExp = this.prefixTestRegex[msg.guild.id];
            let cmdRegex: RegExp = this.commandRegex[msg.guild.id];

            let cmdMatch = msg.content.match(cmdRegex);
            // Check if user called bot without command or command was not found
            if (!cmdMatch || !Object.keys(this.commands).includes(cmdMatch[1])) {
                if (msg.cleanContent.match(testRegex)) {
                    this.failReact(msg);
                }
                return;
            }

            if (!msg.member.hasPermission('BAN_MEMBERS')) {
                this.failReact(msg);
                msg.channel.send('You need to have enough permissions to use this bot!');
                return;
            }

            this.executeCommand(msg, cmdMatch);
        }).bind(this);
    }

    private onGuildCreate(): (guild: Discord.Guild) => void {
        return ((guild: Discord.Guild) => {
            if (this.isBotFarm(guild)) {
                guild.leave();
                return;
            }

            guild.defaultChannel.send(`Hello! I am Safety Jim, \`${this.config.defaultPrefix}\` is my default prefix!`)
                                // tslint:disable-next-line:max-line-length
                                .catch(() => { guild.owner.send(`Hello! I am Safety Jim, \`${this.config.defaultPrefix}\` is my default prefix!`); });
            this.database.createGuildSettings(guild);
            this.database.createGuildPrefix(guild, this.config.defaultPrefix);
            this.database.createWelcomeMessage(guild, defaultWelcomeMessage);
            this.createRegexForGuild(guild.id, this.config.defaultPrefix);
            this.updateDiscordBotLists();
            this.log.info(`Joined guild ${guild.name}`);
        });
    }

    private onGuildMemberAdd(): (member: Discord.GuildMember) => void {
        return (async (member: Discord.GuildMember) => {
            this.log.info(`${member.user.tag} joined guild ${member.guild.name}.`);
            let guildConfig = await this.database.getGuildConfiguration(member.guild);

            if (guildConfig.HoldingRoomActive) {
                if (this.client.channels.has(guildConfig.HoldingRoomChannelID)) {
                    let channel = this.client.channels.get(guildConfig.HoldingRoomChannelID) as Discord.TextChannel;
                    let message = await this.database.getWelcomeMessage(member.guild);
                    let guildMinutes = guildConfig.HoldingRoomMinutes;
                    message = message.replace('$minute', guildMinutes + (guildMinutes === 1 ? ' minute' : ' minutes'))
                                     .replace('$user', member.user.toString())
                                     .replace('$guild', member.guild.name);
                    // tslint:disable-next-line:max-line-length
                    channel.send(message)
                           .catch((err) => { this.log.error(`There was an error when trying to send welcome message in ${member.guild.name}: ${err.toString()}`); });
                } else {
                    this.log.warn(`Could not find holding room channel for ${member.guild.name} : ${member.guild.id}`);
                    member.guild.defaultChannel.send('WARNING: Invalid channel is set as a holding room!');
                }

                this.database.createJoinRecord(member.user, member.guild, guildConfig.HoldingRoomMinutes);
            }
        });
    }

    private onGuildMemberRemove(): (member: Discord.GuildMember) => void {
        return ((member: Discord.GuildMember) => {
            this.database.delJoinEntry(member.user.id, member.guild.id);
        });
    }

    private onGuildDelete(): (guild: Discord.Guild) => void {
        return ((guild: Discord.Guild) => {
            this.database.delGuildSettings(guild);
            this.database.delGuildPrefix(guild);
            delete this.commandRegex[guild.id];
            delete this.prefixTestRegex[guild.id];
            this.updateDiscordBotLists();
        });
    }

    private onDisconnect(): (event: any) => void {
        return ((event: any) => {
            this.log.warn(`Client triggered disconnect event: ${JSON.stringify(event)}`);
        });
    }

    private async executeCommand(msg: Discord.Message, cmdMatch: RegExpMatchArray): Promise<void> {
        let command = cmdMatch[1];
        let args = cmdMatch[2].trim();
        let showUsage;

        try {
            showUsage = this.commands[command].run(this, msg, args);
        } catch (e) {
            await this.failReact(msg);
            msg.channel.send('There was an error running the command:\n' +
                            '```\n' + e.stack + e.lineNumber + e.message + '\n```');
            // tslint:disable-next-line:max-line-length
            this.log.error(`${command} failed with arguments: ${args} in guild "${msg.guild.name}" : ${e.stack + e.lineNumber + e.message}`);
        }

        if (showUsage === true) {
            let usage = this.commands[command].usage;
            let prefix = await this.database.getGuildPrefix(msg.guild);

            await this.failReact(msg);
            msg.channel.send('', { embed: {
                author: {
                    name: `Safety Jim - "${command}" Syntax`,
                    icon_url: this.client.user.avatarURL,
                },
                description: this.getUsageString(prefix, usage),
                color: 0x4286f4,
                } });
        }
    }

    private loadCommands(): void {
        let commandsFolderPath = path.join(__dirname, '..', 'commands');
        if (!fs.existsSync(commandsFolderPath) || !fs.statSync(commandsFolderPath).isDirectory()) {
            this.log.error('Commands directory could not be found!');
            process.exit(1);
        }

        let commandList = fs.readdirSync(commandsFolderPath);

        for (let command of commandList) {
            if (!fs.statSync(path.join(commandsFolderPath, command)).isDirectory()) {
                this.log.warn(`Found file "${command}", ignoring...`);
            } else {
                try {
                    let cmd = require(path.join(commandsFolderPath, command, command + '.js')) as Command;
                    this.commands[command] = new cmd(this);
                    this.log.info(`Loaded command "${command}"`);
                } catch (e) {
                    this.log.warn(`Could not load command "${command}"!`);
                }
            }
        }
    }

    private isBotFarm(guild: Discord.Guild) {
        return (guild.id !== DiscordBotListGuildID) &&
               (guild.id !== DiscordBotsGuildID) &&
               (guild.members.filter((member) => member.user.bot).size > 20);
    }

    private async allowUsers(): Promise<void> {
        let usersToBeAllowed = await this.database.getUsersThatCanBeAllowed();

        for (let user of usersToBeAllowed) {
            let guildConfig = await this.database.getGuildConfiguration(this.client.guilds.get(user.GuildID));

            if (guildConfig.HoldingRoomActive === 1) {
                let dGuild = this.client.guilds.get(user.GuildID);
                let dUser = dGuild.members.get(user.UserID);
                dUser.addRole(guildConfig.HoldingRoomRoleID);
                this.database.updateJoinRecord(user);
                this.log.info(`Allowed "${dUser.user.tag}" in guild "${dGuild.name}".`);
            }
        }
    }

    private async unbanUsers(): Promise<void> {
        let usersToBeUnbanned = await this.database.getExpiredBans();

        if (usersToBeUnbanned == null) {
            return;
        }

        for (let user of usersToBeUnbanned) {
            let g = this.client.guilds.get(user.GuildID);

            if (g == null) {
                this.database.updateBanRecord(user);
            } else {
                try {
                    await g.unban(user.BannedUserID);
                    await this.database.updateBanRecord(user);
                    this.log.info(`Unbanned "${user.BannedUserName}" in guild "${g.name}".`);
                } catch (e) {
                    await this.database.updateBanRecord(user);
                    // tslint:disable-next-line:max-line-length
                    this.log.warn(`Could not unban user ${user.BannedUserName} (${user.BannedUserID}) in guild ${this.client.guilds.get(user.GuildID).id} : ${JSON.stringify(e)}`);
                }
            }
        }
    }

    private async unmuteUsers(): Promise<void> {
        let usersToBeUnmuted = await this.database.getExpiredMutes();

        for (let user of usersToBeUnmuted) {
            let guild = this.client.guilds.get(user.GuildID);

            if (!guild || !guild.roles.find('name', 'Muted')) {
                this.database.updateMuteRecord(user);
                return;
            }

            await this.client.fetchUser(user.MutedUserID);
            let member = await guild.fetchMember(user.MutedUserID);

            if (!member) {
                this.database.updateMuteRecord(user);
                return;
            }

            member.removeRole(guild.roles.find('name', 'Muted'))
                .then(() => {
                    this.database.updateMuteRecord(user);
                })
                .catch(() => { this.log.warn('Could not unmute a user.'); });
        }
    }

    private populateWelcomeMessageDatabase(): void {
        let guildsNotInDatabaseCount = 0;

        this.database.getWelcomeMessages()
                     .then((welcomeMessages) => welcomeMessages.map((m) => m.GuildID))
                     .then((existingGuildIds) => {
                         this.client.guilds.map((guild) => {
                             if (!existingGuildIds.includes(guild.id)) {
                                 this.database.createWelcomeMessage(guild, defaultWelcomeMessage);
                                 guildsNotInDatabaseCount++;
                             }
                         });
                     })
                     .then(() => {
                         if (guildsNotInDatabaseCount) {
                             // tslint:disable-next-line:max-line-length
                             this.log.info(`Added ${guildsNotInDatabaseCount} guild(s) to database with default welcome message.`);
                         }
                     });
    }

    private populateGuildConfigDatabase(): void {
        let guildsNotInDatabaseCount = 0;

        this.database.getGuildConfigurations()
                     .then((configs) => configs.map((config) => config.GuildID))
                     .then((existingGuildIds) => {
                        this.client.guilds.map((guild) => {
                            if (!existingGuildIds.includes(guild.id)) {
                                this.database.createGuildSettings(guild);
                                guildsNotInDatabaseCount++;
                            }
                        });
                     })
                     .then((_) => {
                         if (guildsNotInDatabaseCount) {
                             // tslint:disable-next-line:max-line-length
                             this.log.info(`Added ${guildsNotInDatabaseCount} guild(s) to database with default config.`);
                         }
                     });
    }

    private populatePrefixDatabase(): void {
        let existingRegexList = Object.keys(this.commandRegex);
        let guildsNotInDatabaseCount = 0;

        this.client.guilds.map((guild) => {
            if (!existingRegexList.includes(guild.id)) {
                this.createRegexForGuild(guild.id, this.config.defaultPrefix);
                this.database.createGuildPrefix(guild, this.config.defaultPrefix);
                guildsNotInDatabaseCount++;
            }
        });

        if (guildsNotInDatabaseCount) {
            this.log.info(`Added ${guildsNotInDatabaseCount} guild(s) to database with default prefix.`);
        }
    }
}
