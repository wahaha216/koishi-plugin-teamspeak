import { Context, Element, h, Schema } from "koishi";
import { Query, Events, Client, Channel } from "@wahaha216/teamspeak.js";

export const name = "teamspeak";

export interface Config {
  host: string;
  port: number;
  protocol: "ssh" | "tcp";
  username: string;
  password: string;
  autoReconnect: boolean;
  retryCount: number;
  push: {
    platform: string;
    channelId: string;
    enter: boolean;
    leave: boolean;
    move: boolean;
    message: boolean;
  }[];
  simplifiedMode: boolean;
  debug: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    host: Schema.string().required(),
    port: Schema.number().default(10022),
    protocol: Schema.union(["ssh", "tcp"]).default("ssh"),
    username: Schema.string().default("serveradmin"),
    password: Schema.string().required(),
  }),
  Schema.object({
    autoReconnect: Schema.boolean().default(true),
    retryCount: Schema.number().min(1).default(5),
  }),
  Schema.object({
    push: Schema.array(
      Schema.object({
        platform: Schema.string().required(),
        channelId: Schema.string().required(),
        enter: Schema.boolean().default(true),
        leave: Schema.boolean().default(false),
        move: Schema.boolean().default(false),
        message: Schema.boolean().default(false),
      }),
    ).role("table"),
    simplifiedMode: Schema.boolean().default(true),
  }),
  Schema.object({
    debug: Schema.boolean().default(false),
  }),
]).i18n({
  "zh-CN": require("./locales/zh-CN")._config,
  "en-US": require("./locales/en-US")._config,
});

type QueryOptions = ConstructorParameters<typeof Query>[0];
type Event = "enter" | "leave" | "move" | "message";

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("teamspeak");

  // i18n
  ctx.i18n.define("en-US", require("./locales/en-US"));
  ctx.i18n.define("zh-CN", require("./locales/zh-CN"));

  let query: Query | null = null;
  let retryAttempts = 0;
  let timer: NodeJS.Timeout | null = null;
  const delays = [5000, 10000, 20000, 30000];

  const destroy = () => {
    if (query) {
      if (config.debug)
        logger.info("[destroy] 实例存在，移除所有监听器以及销毁实例");
      query.removeAllListeners();
      query.destroy();
      query = null;
    }
  };

  const connect = async () => {
    if (query) {
      logger.error("[connect] 连接已存在！");
      return;
    }
    if (!config.host) {
      logger.error("[connect] 未配置服务器地址!");
      return;
    }

    const clientOptions: QueryOptions = {
      host: config.host,
      port: config.port,
      protocol: config.protocol,
    };
    if (config.protocol === "ssh") {
      clientOptions.ssh = {
        username: config.username,
        password: config.password,
      };
    }
    if (config.debug) {
      logger.info(
        `[connect] 客户端配置：\n${JSON.stringify(clientOptions, null, 2)}`,
      );
    }
    query = new Query(clientOptions);
    query.on("Ready", async () => {
      logger.info(`[connect] 连接至 ${config.host}:${config.port} 成功！`);
      retryAttempts = 0; // 重置重试次数
      if (config.protocol === "tcp") {
        await query.login(config.username, config.password);
      }
      await query.virtualServers.use(1);
      await query.notifications.subscribeAll();
      // 查询所有用户
      await query.clients.fetch();
    });
    query.on("error", async (err) => {
      logger.error(`[connect] 连接错误: ${err.message}`);
    });
    query.on("Close", async () => {
      if (config.autoReconnect) {
        const reconnectTime = delays[retryAttempts] || 60000;
        const reconnectMsg =
          config.retryCount === 0
            ? `第${retryAttempts + 1}次尝试`
            : `${retryAttempts + 1}/${config.retryCount}`;
        if (config.retryCount === 0 || retryAttempts < config.retryCount) {
          logger.info(
            `[connect] 连接已关闭，将在${reconnectTime / 1000}秒后尝试重连...${reconnectMsg}`,
          );
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            retryAttempts++;
            connect();
          }, reconnectTime);
        } else {
          logger.error("[connect] 重连失败，已达到最大重试次数！");
        }
      }
      destroy();
    });
    query.on(Events.ClientEnterView, async (_client) => {
      const client = await _client.fetch();
      if (config.debug) {
        logger.info("用户进入", {
          id: client.id,
          channelId: client.channelId,
          databaseId: client.databaseId,
          uniqueId: client.uniqueId,
          nickname: client.nickname,
          type: client.type,
          description: client.description,
          inputMuted: client.inputMuted,
          outputMuted: client.outputMuted,
          isRecording: client.isRecording,
          isStreaming: client.isStreaming,
          away: client.away,
          awayMessage: client.awayMessage,
        });
      }

      await pushToChannel(
        [h.text(`${client.nickname} 进入了TeamSpeak`)],
        "enter",
      );
    });
    query.on(Events.ClientLeaveView, async (client) => {
      if (client.type === 1) return;
      if (config.debug) {
        logger.info("用户离开", {
          id: client.id,
          channelId: client.channelId,
          databaseId: client.databaseId,
          uniqueId: client.uniqueId,
          nickname: client.nickname,
          type: client.type,
          description: client.description,
        });
      }
      await pushToChannel(
        [h.text(`${client.nickname} 离开了TeamSpeak`)],
        "leave",
      );
    });
    query.on(Events.ClientMove, async (_client, _o, _n) => {
      const client = await _client.fetch();
      const o = await _o.fetch();
      const n = await _n.fetch();
      if (config.debug) {
        logger.info("用户移动", {
          id: client.id,
          channelId: client.channelId,
          databaseId: client.databaseId,
          uniqueId: client.uniqueId,
          nickname: client.nickname,
          type: client.type,
          description: client.description,
        });

        const log = (msg: string, channel: Channel) => {
          logger.info(msg, {
            id: channel.id,
            parentId: channel.parentId,
            name: channel.name,
            topic: channel.topic,
            description: channel.description,
            password: channel.password,
            codec: channel.codec,
            codecQuality: channel.codecQuality,
            maxClients: channel.maxClients,
            maxFamilyClients: channel.maxFamilyClients,
            order: channel.order,
            type: channel.type,
            default: channel.default,
            latencyFactor: channel.latencyFactor,
            codecUnencrypted: channel.codecUnencrypted,
            securitySalt: channel.securitySalt,
            deleteDelay: channel.deleteDelay,
            uniqueId: channel.uniqueId,
            maxClientsUnlimited: channel.maxClientsUnlimited,
            maxFamilyClientsUnlimited: channel.maxFamilyClientsUnlimited,
            maxFamilyClientsInherited: channel.maxFamilyClientsInherited,
            filepath: channel.filepath,
            neededTalkPower: channel.neededTalkPower,
            forcedSilence: channel.forcedSilence,
            namePhonetic: channel.namePhonetic,
            iconId: channel.iconId,
            bannerGfxUrl: channel.bannerGfxUrl,
            bannerMode: channel.bannerMode,
            secondsEmpty: channel.secondsEmpty,
          });
        };
        log("旧频道", o);
        log("新频道", n);
      }
      await pushToChannel(
        [h.text(`${client.nickname} 从 ${o.name} 移动到了 ${n.name}`)],
        "move",
      );
    });
    query.on(Events.TextMessage, async (textMessage) => {
      await pushToChannel([h.text(textMessage.content)], "message");
    });
    query.connect();
  };

  connect();

  const pushToChannel = async (content: Element.Fragment, type: Event) => {
    for (const bot of ctx.bots) {
      for (const push of config.push) {
        if (push[type] && bot.platform === push.platform) {
          await bot.sendMessage(push.channelId, content);
        }
      }
    }
  };

  ctx.command("ts").action(async ({ session }) => {
    const messageId = session.messageId;
    if (query) {
      const rawClients = await query.clients.fetch();

      const clients = [...rawClients.values()].filter(
        (client) => client.type !== 1,
      );

      if (clients.length === 0) {
        await session.send([
          h.quote(messageId),
          h.text(session.text(".noOne")),
        ]);
        return;
      }

      const channels = await query.channels.fetch();
      const allChannels = [...channels.values()];
      const channelToClients = new Map<number, Client[]>();

      for (const client of clients) {
        const channelId = client.channel?.id || client.channelId;
        if (!channelId) continue;

        if (!channelToClients.has(channelId))
          channelToClients.set(channelId, []);
        channelToClients.get(channelId)!.push(client);
      }

      const replyLines: string[] = [];
      replyLines.push(`======== TeamSpeak ========`);

      const totalRealPlayers = clients.length;

      // 排序
      const sortedChannels = allChannels.sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      );

      for (const channel of sortedChannels) {
        const clientsInChannel = channelToClients.get(channel.id) || [];
        // 只显示有人的频道
        if (clientsInChannel.length > 0) {
          const channelName =
            channel.name || session.text(".canNotGetChannelName", [channel.id]);
          replyLines.push(`${channelName}：`);

          if (config.simplifiedMode) {
            const clientList = clientsInChannel
              .map((c) => c.nickname)
              .join("、");
            replyLines.push(`\t${clientList}`);
          } else {
            query.clients.cache.clear();
            for (let client of clientsInChannel) {
              client = await client.fetch();

              let text = `${client.nickname} `;
              if (client.inputMuted) text += session.text(".inputMuted");
              if (client.outputMuted) text += session.text(".outputMuted");
              if (client.isRecording) text += session.text(".recording");
              if (client.isStreaming) text += session.text(".streaming");
              if (client.away)
                text += session.text(client.awayMessage ? ".afkMsg" : ".afk", [
                  client.awayMessage,
                ]);
              replyLines.push(`\t${text}`);
            }
          }
        }
      }

      replyLines.push(`==============================`);
      replyLines.push(session.text(".totalOnline", [totalRealPlayers]));

      return replyLines.join("\n");
    } else {
      await session.send([
        h.quote(messageId),
        h.text(session.text(".noConnect")),
      ]);
    }
  });

  ctx.on("dispose", () => {
    destroy();
    if (timer) clearTimeout(timer);
  });
}
