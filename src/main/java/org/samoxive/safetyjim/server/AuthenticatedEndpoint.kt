package org.samoxive.safetyjim.server

import io.vertx.core.http.HttpServerRequest
import io.vertx.core.http.HttpServerResponse
import io.vertx.ext.web.RoutingContext
import net.dv8tion.jda.core.entities.User
import org.jetbrains.exposed.sql.transactions.transaction
import org.samoxive.safetyjim.database.OauthSecret
import org.samoxive.safetyjim.discord.DiscordBot
import org.samoxive.safetyjim.server.AbstractEndpoint.Companion.Status
import org.samoxive.safetyjim.server.AbstractEndpoint.Companion.Result
import org.samoxive.safetyjim.tryhardAsync

abstract class AuthenticatedEndpoint(bot: DiscordBot): AbstractEndpoint(bot) {
    override suspend fun handle(event: RoutingContext, request: HttpServerRequest, response: HttpServerResponse): Companion.Result {
        val token = request.getHeader("token") ?: return Result(Status.BAD_REQUEST)
        val userId = getUserIdFromToken(bot.config, token) ?: return Result(Status.UNAUTHORIZED)
        transaction { OauthSecret.findById(userId) } ?: return Result(Status.UNAUTHORIZED)
        val user = tryhardAsync { bot.shards[0].jda.retrieveUserById(userId).complete() } ?: return Result(Status.UNAUTHORIZED)
        return handle(event, request, response, user)
    }

    abstract suspend fun handle(event: RoutingContext, request: HttpServerRequest, response: HttpServerResponse, user: User): Companion.Result
}