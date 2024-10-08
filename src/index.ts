import "dotenv/config";
import { Client, Message, GatewayIntentBits } from "discord.js";
import { Soul } from "@opensouls/engine";
import fetch from "node-fetch";

export type DiscordEventData = {
  type: "messageCreate";
  messageId: string;
  channelId: string;
  guildId: string | null;
  userId: string;
  userDisplayName: string;
  atMentionUsername: string;
  repliedToUserId?: string;
  isHost: boolean;
};

function createDiscordEventData(message: Message): DiscordEventData {
  return {
    type: "messageCreate",
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guild?.id || null,
    userId: message.author.id,
    userDisplayName: message.member?.displayName || message.author.username,
    atMentionUsername: message.author.username,
    repliedToUserId: message.mentions.users.first()?.id,
    isHost: message.author.bot,
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const lastMessageChannel = new Map<string, Message>();

client.on("ready", async () => {
  console.log(`Bot is ready! Logged in as ${client.user?.tag}`);
  
  try {
    // Get the first guild (server) the bot is in
    const guild = client.guilds.cache.first();
    if (guild) {
      // Find the first text channel in the guild
      const channel = guild.channels.cache.find(ch => ch.isTextBased());
      if (channel) {
        await channel.send("Hello! I'm now connected and ready to chat.");
        console.log(`Successfully sent connection message to channel ${channel.name} in server ${guild.name}`);
      } else {
        console.log(`No text channels found in server ${guild.name}`);
      }
    } else {
      console.log("Bot is not in any servers.");
    }
  } catch (error) {
    console.error("Error sending connection message:", error);
  }

  // Log the servers the bot is currently in
  console.log("Current servers:");
  client.guilds.cache.forEach((guild) => {
    console.log(`- ${guild.name} (ID: ${guild.id})`);
  });
});

client.on("messageCreate", (message) => {
  const emoji = message.author.bot ? "🤖" : "👤";
  console.log(`${emoji} ${message.author.username}: ${message.content}`);
  // Store the message context to use for replies
  lastMessageChannel.set(message.channelId, message);
});

const soul = new Soul({
  organization: process.env.SOUL_ORGANIZATION,
  blueprint: process.env.SOUL_BLUEPRINT,
  soulID: process.env.SOUL_ID,
  token: process.env.SOUL_ENGINE_API_KEY,
  debug: true,
});

soul
  .connect()
  .then(() => {
    console.log("Soul connected successfully.");
  })
  .catch(console.error);

soul.on("says", async ({ content }) => {
  const channelId = Array.from(lastMessageChannel.keys())[
    lastMessageChannel.size - 1
  ];
  const message = lastMessageChannel.get(channelId);
  if (message && message.author.id !== client.user?.id) {
    const response = await content();
    console.log(`🤖 Host is replying to ${message.author.username}: ${response}`);
    message.reply(response).catch(console.error);
    lastMessageChannel.delete(channelId);
  }
});

soul.on("paint", async (evt: any) => {
  console.log("🎨👻 paint interaction request detected from soul:");
  console.log("Received event:", JSON.stringify(evt, null, 2));

  console.log("_metadata:");
  console.log(JSON.stringify(evt._metadata, null, 2));

  console.log("prompt:");
  console.log(evt._metadata.prompt);

  const discordMessage = evt._metadata.discordMessage;
  if (!discordMessage) {
    console.error("Discord message metadata is missing");
    return;
  }

  const messageId = discordMessage.messageId;
  const channelId = discordMessage.channelId;
  const prompt = evt._metadata.prompt;

  if (!prompt) {
    console.error("Prompt is missing");
    return;
  }

  console.log(messageId);

  console.log(`🧠 making request to /brain to paint ${prompt}...`);

  try {
    const response = await fetch("http://brain.tanaki.app/paint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: prompt }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    let data;

    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else if (contentType && contentType.includes("text/plain")) {
      data = await response.text();
    } else if (contentType && contentType.includes("text/html")) {
      data = await response.text();
      console.warn(`Received HTML response: ${data}`);
    } else {
      throw new Error(`Unsupported response type: ${contentType}`);
    }

    console.log("🖼️ painting is complete:");
    console.log(data.message || data);

    const imgURL = data.message?.toString() || data.toString();

    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(imgURL);
    }
  } catch (error) {
    console.error("Error:", error);
  }
});

client.on("messageCreate", (message) => {
  if (message.author.id === client.user?.id) {
    console.log("Ignoring message from self");
    return;
  }

  const discordEvent = createDiscordEventData(message);

  soul.dispatch({
    action: "chatted",
    content: message.content,
    name: discordEvent.atMentionUsername,
    _metadata: {
      discordEvent,
      discordUserId: client.user?.id,
    },
  });
});

client.login(process.env.BOT_TOKEN);