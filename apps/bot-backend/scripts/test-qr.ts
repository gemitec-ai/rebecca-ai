import { XApiService } from '../src/services/xApi';
import { GeminiService } from '../src/services/gemini';
import { getActivePersona } from '@rebecca/persona';
import { buildSystemPrompt } from '../src/core/contextInjector';
import { downloadImage } from '../src/utils/image';
import * as xdk from '@xdevplatform/xdk';
import config from '../src/config';
import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
    console.log('Testing Quote Repost on first followed account...');
    const xApi = new XApiService(config.xApi);
    const gemini = new GeminiService(config.gemini);
    try {
        const oauth1Client = new xdk.OAuth1({
            apiKey: config.xApi.appKey || '',
            apiSecret: config.xApi.appSecret || '',
            callback: 'oob',
            accessToken: config.xApi.accessToken || '',
            accessTokenSecret: config.xApi.accessSecret || '',
        });
        const client = new xdk.Client({
            oauth1: oauth1Client
        });
        
        // 1. Get first user that the bot follows
        const botMe = await client.users.getMe();
        const followingRes = await client.users.getFollowing(botMe.data.id, { max_results: 5 });
        if (!followingRes.data || followingRes.data.length === 0) {
            console.log("Bot is not following anyone.");
            return;
        }
        const targetUser = followingRes.data[0];
        const userId = targetUser.id;
        const targetHandle = targetUser.username;
        console.log(`Resolved target user from following: @${targetHandle} (${userId})`);
        
        // 2. Fetch latest tweet
        const recentTweets = await xApi.getUserTweets(userId, 5);
        if (!recentTweets.data || recentTweets.data.length === 0) {
            console.log(`No recent tweets found for @${targetHandle}.`);
            return;
        }
        
        const latestTweet = recentTweets.data[0];
        const targetTweetId = latestTweet.id;
        let tweetContext = `\n【直近の投稿内容】\n${latestTweet.text}`;
        
        const mediaKeys = latestTweet.attachments?.media_keys;
        if (mediaKeys && mediaKeys.length > 0 && recentTweets.includes?.media) {
            for (const media of recentTweets.includes.media) {
                if (media.type === 'photo' && media.url) {
                    console.log(`Downloading image: ${media.url}`);
                    const { buffer, mimeType } = await downloadImage(media.url);
                    const imageCaption = await gemini.analyzeImageCaption(buffer, mimeType);
                    if (imageCaption) {
                        tweetContext += `\n\n【ユーザーが添付した画像の内容】\n${imageCaption}`;
                    }
                }
            }
        }
        
        console.log("Tweet Context:", tweetContext);
        
        const lang = await gemini.detectLanguage(tweetContext);
        const { systemInstruction: systemPrompt } = await buildSystemPrompt({
            persona: getActivePersona(),
            promptContext: 'random_engagement',
            lang,
            gemini,
            anchoringContext: [tweetContext],
        });
        const userInput = `【ターゲットユーザー情報】\nユーザー名: @${targetHandle}\n${tweetContext}\n\n上記を踏まえて、ターゲットユーザーの最新の投稿に対して不意打ちで引用リポスト（話しかけ）を行ってください。`;
        
        const structured = await gemini.generateStructuredReply(systemPrompt, [], userInput);
        const generatedText = structured.reply;
        if (structured.thought) {
            console.log(`Generated Quote Repost Thought:\n${structured.thought}`);
        }
        
        let finalText = generatedText;
        if (!finalText.includes(`@${targetHandle}`)) {
            finalText = `@${targetHandle}\n${finalText}`;
        }
        
        console.log(`Generated Quote Repost Text:\n${finalText}`);
        
        const tweetRes = await xApi.tweet(finalText, { quote_tweet_id: targetTweetId });
        console.log("Success! Tweet ID:", tweetRes?.data?.id);
        
    } catch (e: unknown) {
        console.error("Test failed:", e);
        if (typeof e === 'object' && e !== null && 'data' in e) {
            console.error("API Error Data:", JSON.stringify((e as { data: unknown }).data, null, 2));
        }
    }
};

run();
