import { CortexStep, brainstorm, decision, externalDialog, internalMonologue } from "socialagi";
import { MentalProcess, VectorRecordWithSimilarity, useActions, usePerceptions, useRag, useSoulMemory } from "soul-engine";
import { Perception } from "soul-engine/soul";
import { DiscordEventData } from "../discord/soulGateway.js";
import { getMetadataFromPerception, getUserDataFromDiscordEvent, newMemory } from "./lib/utils.js";
import { prompt } from "./lib/prompt.js";

const initialProcess: MentalProcess = async ({ step: initialStep }) => {
  const { log, dispatch } = useActions();
  const { invokingPerception, pendingPerceptions } = usePerceptions();
  const { userName, discordEvent: discordMessageMetadata } = getMetadataFromPerception(invokingPerception);

  const hasReachedPendingPerceptionsLimit = pendingPerceptions.current.length > 10;
  if (hasReachedPendingPerceptionsLimit) {
    log("Pending perceptions limit reached. Skipping perception.");
    return initialStep;
  }

  const isMessageBurst = hasMoreMessagesFromSameUser(pendingPerceptions.current, userName);
  if (isMessageBurst) {
    log(`Skipping perception from ${userName} because it's part of a message burst`);
    return initialStep;
  }

  let step = rememberUser(initialStep, discordMessageMetadata);

  const shouldReply = await isUserTalkingToHost(invokingPerception, step, userName);
  if (!shouldReply) {
    log(`Ignoring message from ${userName} because they're not talking to Host`);
    return initialStep;
  }

  const userSentNewMessagesInMeantime = hasMoreMessagesFromSameUser(pendingPerceptions.current, userName);
  if (userSentNewMessagesInMeantime) {
    log(`Aborting response to ${userName} because they've sent more messages in the meantime`);
    return initialStep;
  }



  step = await withSearchResults(step, invokingPerception);

  log(`Answering message from ${userName}`);

  const { stream, nextStep } = await step.next(externalDialog(`Host answers ${userName}'s message`), {
    stream: true,
    model: "quality",
  });


  dispatch({
    action: "says",
    content: stream,
    _metadata: {
      discordEvent: discordMessageMetadata,
    },
  });

  return await nextStep;
};

function hasMoreMessagesFromSameUser(pendingPerceptions: Perception[], userName: string) {
  const countOfPendingPerceptionsBySamePerson = pendingPerceptions.filter((perception) => {
    return getMetadataFromPerception(perception)?.userName === userName;
  }).length;

  return countOfPendingPerceptionsBySamePerson > 0;
}



async function isUserTalkingToHost(
  perception: Perception | undefined | null,
  step: CortexStep<any>,
  userName: string
) {
  const { log } = useActions();

  const discordUserId = soul.env.discordUserId?.toString();
  if (discordUserId && perception && perception.content.includes(`<@${discordUserId}>`)) {
    log(`User at-mentioned Host, will reply`);
    return true;
  }

  const interlocutor = await step.compute(
    decision(
      `Glandon is the moderator of this channel. Participants sometimes talk to Glandon, and sometimes between themselves. In this last message sent by ${userName}, guess which person they are probably speaking with.`,
      ["Glandon, for sure", "Glandon, possibly", "someone else", "not sure"]
    ),
    {
      model: "quality",
    }
  );

  log(`Glandon decided that ${userName} is talking to: ${interlocutor}`);

  return interlocutor.toString().startsWith("Glandon");
}

async function withSearchResults(step: CortexStep<any>, invokingPerception: Perception | null | undefined) {
  const { log } = useActions();
  const { search } = useRag();
  const { content: userMessage } = getMetadataFromPerception(invokingPerception);
  
  const retrievedContent = await search({
    query: userMessage,
    maxDistance: 0.6, // this is actually the minimum similarity
  }) as VectorRecordWithSimilarity[]
  
  const results = retrievedContent.map((doc) => ({
    content: doc.content,
    similarity: doc.similarity,
  }));

  const sortedResults = results.sort((a, b) => b.similarity - a.similarity);
  const firstThreeResults = sortedResults.slice(0, 3);

  log(prompt`
    Found ${results.length} related documents with RAG search, using best ${firstThreeResults.length} results:
    ${firstThreeResults.map((result) => `- ${result.content?.toString().slice(0, 100)}... (similarity: ${result.similarity})`).join("\n")}
  `);

  const content = firstThreeResults.map((result) => `- ${result.content}`).join("\n");

  return step.withMemory(
    newMemory(prompt`
      Glandon remembers:
      ${content}
    `)
  );
}



function rememberUser(step: CortexStep<any>, discordEvent: DiscordEventData | undefined) {
  const { log } = useActions();
  const { userName, userDisplayName } = getUserDataFromDiscordEvent(discordEvent);

  const userModel = useSoulMemory(userName, `- Display name: "${userDisplayName}"`);
  const userLastMessage = useSoulMemory(userName + "-lastMessage", "");

  let remembered = "";

  if (userModel.current) {
    remembered += userModel.current;
  }

  if (userLastMessage.current) {
    remembered += `\n\nThe last message Glandon sent to ${userName} was:\n- ${userLastMessage.current}`;
  }

  remembered = remembered.trim();

  if (remembered.length > 0) {
    log(`Remembered this about ${userName}:\n${remembered}`);

    remembered = `Glandon remembers this about ${userName}:\n${remembered.trim()}`;
    step = step.withMemory(newMemory(remembered));
  } else {
    log(`No memory about ${userName}`);
  }

  return step;
}

export default initialProcess;
