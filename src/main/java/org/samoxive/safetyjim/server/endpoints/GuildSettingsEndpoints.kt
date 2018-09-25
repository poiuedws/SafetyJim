package org.samoxive.safetyjim.server.endpoints

import io.vertx.core.http.HttpMethod
import io.vertx.core.http.HttpServerRequest
import io.vertx.core.http.HttpServerResponse
import io.vertx.ext.web.RoutingContext
import kotlinx.serialization.json.JSON
import net.dv8tion.jda.core.Permission
import net.dv8tion.jda.core.entities.Guild
import net.dv8tion.jda.core.entities.Member
import net.dv8tion.jda.core.entities.User
import org.jetbrains.exposed.sql.transactions.transaction
import org.samoxive.safetyjim.database.createGuildSettings
import org.samoxive.safetyjim.database.deleteGuildSettings
import org.samoxive.safetyjim.database.getGuildSettings
import org.samoxive.safetyjim.discord.DiscordBot
import org.samoxive.safetyjim.server.*
import org.samoxive.safetyjim.server.entities.GuildSettingsEntity
import org.samoxive.safetyjim.server.entities.toChannelEntity
import org.samoxive.safetyjim.server.entities.toGuildEntity
import org.samoxive.safetyjim.server.entities.toRoleEntity
import org.samoxive.safetyjim.tryhard
import org.samoxive.safetyjim.tryhardAsync

class GetGuildSettingsEndpoint(bot: DiscordBot): AuthenticatedGuildEndpoint(bot) {
    override val route = "/guilds/:guildId/settings"
    override val method = HttpMethod.GET

    override suspend fun handle(event: RoutingContext, request: HttpServerRequest, response: HttpServerResponse, user: User, guild: Guild, member: Member): Result {
        val guildSettingsDb = getGuildSettings(guild, bot.config)
        val settings = GuildSettingsEntity(
            guild.toGuildEntity(),
            guildSettingsDb.modlog,
            guild.getTextChannelById(guildSettingsDb.modlogchannelid)?.toChannelEntity() ?: return Result(Status.SERVER_ERROR),
            guildSettingsDb.holdingroom,
            guild.getRoleById(guildSettingsDb.holdingroomroleid)?.toRoleEntity(),
            guildSettingsDb.holdingroomminutes,
            guildSettingsDb.invitelinkremover,
            guildSettingsDb.welcomemessage,
            guildSettingsDb.message,
            guild.getTextChannelById(guildSettingsDb.welcomemessagechannelid)?.toChannelEntity() ?: return Result(Status.SERVER_ERROR),
            guildSettingsDb.prefix,
            guildSettingsDb.silentcommands,
            guildSettingsDb.nospaceprefix,
            guildSettingsDb.statistics
        )

        response.endJson(settings)
        return Result(Status.OK)
    }
}

class PostGuildSettingsEndpoint(bot: DiscordBot): AuthenticatedGuildEndpoint(bot) {
    override val route = "/guilds/:guildId/settings"
    override val method = HttpMethod.POST

    override suspend fun handle(event: RoutingContext, request: HttpServerRequest, response: HttpServerResponse, user: User, guild: Guild, member: Member): Result {
        if (!member.hasPermission(Permission.ADMINISTRATOR)) {
            return Result(Status.FORBIDDEN)
        }
        val bodyString = event.bodyAsString ?: return Result(Status.BAD_REQUEST)
        val newSettings = tryhard { JSON.parse<GuildSettingsEntity>(bodyString) } ?: return Result(Status.BAD_REQUEST)

        guild.textChannels.find { it.id == newSettings.modLogChannel.id } ?: return Result(Status.BAD_REQUEST)
        guild.textChannels.find { it.id == newSettings.welcomeMessageChannel.id } ?: return Result(Status.BAD_REQUEST)
        if (newSettings.holdingRoomRole != null) {
            guild.roles.find { it.id == newSettings.holdingRoomRole.id } ?: return Result(Status.BAD_REQUEST)
        }

        val message = newSettings.message
        val prefix = newSettings.prefix
        if (message.isBlank() || prefix.isBlank()) {
            return Result(Status.BAD_REQUEST)
        } else {
            if (prefix.split(" ").size != 1) {
                return Result(Status.BAD_REQUEST)
            }

            if (prefix.length >= 1000 || message.length >= 1750) {
                return Result(Status.BAD_REQUEST)
            }
        }

        if (newSettings.guild.id != guild.id) {
            return Result(Status.BAD_REQUEST)
        }

        val guildSettingsDb = getGuildSettings(guild, bot.config)
        tryhardAsync {
            transaction {
                guildSettingsDb.modlog = newSettings.modLog
                guildSettingsDb.modlogchannelid = newSettings.modLogChannel.id
                guildSettingsDb.holdingroom = newSettings.holdingRoom
                guildSettingsDb.holdingroomroleid = newSettings.holdingRoomRole?.id
                guildSettingsDb.holdingroomminutes = newSettings.holdingRoomMinutes
                guildSettingsDb.invitelinkremover = newSettings.inviteLinkRemover
                guildSettingsDb.welcomemessage = newSettings.welcomeMessage
                guildSettingsDb.message = newSettings.message
                guildSettingsDb.welcomemessagechannelid = newSettings.welcomeMessageChannel.id
                guildSettingsDb.prefix = newSettings.prefix
                guildSettingsDb.silentcommands = newSettings.silentCommands
                guildSettingsDb.nospaceprefix = newSettings.noSpacePrefix
                guildSettingsDb.statistics = newSettings.statistics
            }
        } ?: return Result(Status.SERVER_ERROR)

        response.end()
        return Result(Status.OK)
    }
}

class ResetGuildSettingsEndpoint(bot: DiscordBot): AuthenticatedGuildEndpoint(bot) {
    override val route = "/guilds/:guildId/settings"
    override val method = HttpMethod.DELETE

    override suspend fun handle(event: RoutingContext, request: HttpServerRequest, response: HttpServerResponse, user: User, guild: Guild, member: Member): Result {
        if (!member.hasPermission(Permission.ADMINISTRATOR)) {
            return Result(Status.FORBIDDEN)
        }

        deleteGuildSettings(guild)
        createGuildSettings(guild, bot.config)
        response.end()
        return Result(Status.OK)
    }
}