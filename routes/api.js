const express = require('express');
const router = express.Router();

const https = require('https');
const nacl = require('tweetnacl');
const Rcon = require('../node-rcon/RCON');
const mariadb = require('mariadb');

const debug = require('debug')('discord-whitelist:api');
const debug_in = require('debug')('discord-whitelist:api-inbound');
const debug_out = require('debug')('discord-whitelist:api-outbound');

const rcon = new Rcon();

const PUBLIC_KEY = process.env.PUBLIC_KEY;
const APPLICATION_ID = process.env.APPLICATION_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const dbpool = mariadb.createPool(
    {
        host: process.env.DATABASE_HOST,
        port: process.env.DATABASE_PORT,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASS,
        database: process.env.DATABASE_DATABASE,
        connectionLimit: 5
    }
);

function insertString(input, index, insersion) {
    return input.slice(0, index) + insersion + input.slice(index);
}

function xuidToUuid(xuid) {
    if (xuid === null) return null;
    //Convert to number
    xuid = parseInt(xuid);
    //Convert to HEX
    let uuid = xuid.toString(16);

    //Will do weird things if the uuid is longer than 32, however I have not seen it longer than 13

    //Pad to length 32 but prepending 0's
    uuid = uuid.padStart(32, '0');

    //Insert hyphens for UUID format
    uuid = insertString(uuid, 8, '-');
    uuid = insertString(uuid, 13, '-');
    uuid = insertString(uuid, 18, '-');
    uuid = insertString(uuid, 23, '-');

    //Return result
    return uuid;
}

async function usernameToXuid(username) {
    //Setup request options, including auth
    const options = {
        method: 'GET',
        headers: {
            'X-AUTH': process.env.XAPI_AUTH
        }
    };
    //Send request and return response
    try {
        return await new Promise((resolve, reject) => {
            const req = https.request(`https://xapi.us/v2/xuid/${username}`, options, (res) => {
                if (res.statusCode === 404) {
                    return reject(404);
                }
                let data = '';
                res.on('data', (stream) => {
                    data += stream;
                });
                res.on('end', () => {
                    resolve(data);
                });
            });
            req.end();
        });

    } catch (error) {
        if (error === 404) {
            return null;
        }
    }
}

router.post('/interactions', function (req, res, next) {
    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');
    const body = JSON.stringify(req.body); // rawBody is expected to be a string, not raw bytes
    const isVerified = nacl.sign.detached.verify(
        Buffer.from(timestamp + body),
        Buffer.from(signature, 'hex'),
        Buffer.from(PUBLIC_KEY, 'hex')
    );
    if (!isVerified) {
        // debug('Invalid Signature');
        return res.status(401).end('Invalid request signature');
    }
    next();
});

router.post('/interactions', async function (req, res) {
    switch (req.body.type) {
        case 1: //PING
            res.status(200).json({
                'type': 1
            });
            break;
        case 2: //APPLICATION_COMMAND
            // debug_in(req.body);

            switch (req.body.data.name) {
                case 'whitelist':
                    let conn = await dbpool.getConnection();
                    let message = '';
                    let ephermeral = true;

                    let username = undefined;
                    let platform = undefined;

                    if ('options' in req.body.data) {
                        // debug_in(req.body.data.options);
                        req.body.data.options.forEach(option => {
                            switch (option.name) {
                                case 'username':
                                    username = option.value;
                                    break;
                                case 'platform':
                                    platform = option.value;
                                    break;
                                default:
                                    break;
                            }
                        });
                    }

                    //Get user last activity (join date or last whitelist time)
                    const joined = new Date(req.body.member.joined_at);
                    const lastWhiteListDB = await conn.query('SELECT `time_accessed` FROM `User` WHERE `discord_id`=? ORDER BY `transaction_id` DESC LIMIT 1;', [req.body.member.user.id]);

                    const lastWhiteList = lastWhiteListDB.length > 0 ? lastWhiteListDB[0]['time_accessed'] : joined;

                    debug(lastWhiteList);

                    let tcon = {};
                    tcon.second = 1000;
                    tcon.minute = tcon.second * 60;
                    tcon.hour = tcon.minute * 60;
                    tcon.day = tcon.hour * 24;
                    tcon.year = tcon.day * 365;

                    let activityRequirement = lastWhiteList.getTime() + tcon.day * 3 <= Date.now();
                    const helpChannelID = process.env.DISCORD_HELP_CHANNEL;

                    if (!activityRequirement) {
                        if (!lastWhiteListDB) {
                            message = `You need to be in this Discord server for at least 3 days to be whitelisted on the SMP.\nYou can whitelist in <t:${Math.ceil((lastWhiteList.getTime() + tcon.day * 3) / 1000)}:R>.`;
                        } else {
                            message = `You need to wait at least 3 days to be whitelist another account on the SMP.\nYou can whitelist again in <t:${Math.ceil((lastWhiteList.getTime() + tcon.day * 3) / 1000)}:R>.`;
                        }
                    } else if (username.match(/[^A-z0-9_]/g)) {
                        message = `You have special characters in your username, these aren't allowed.\nOnly allowed are \`A-z\`, \`0-9\`, and \`_\``;
                    } else if (username.length > 16 || username.length < 3) {
                        message = `Your username is too long or too short, it must be between 3 and 16 characters.`;
                    } else {
                        if (platform === 'java') {
                            message = `Attempting to whitelist \`${username}\` on \`${platform}\``;

                            const rconResponse = await rcon.send(`whitelist add ${username}`);
                            if (rconResponse.includes('That player does not exist')) { //Could not find player
                                message = `Could not find that username (\`${username}\`), please check your username and spelling, then try again.`;
                            } else if (rconResponse.includes('Player is already whitelisted')) { //Already whitelisted
                                message = `\`${username}\` is already on the whitelist!`;
                            } else if (rconResponse.includes('to the whitelist')) { //Success
                                message = `Success! \`${username}\` has been added to the whitelist.`;
                                await conn.query('INSERT INTO `User` (`discord_id`, `mc_username`, `platform`) VALUES (?, ?, "java");', [req.body.member.user.id, username]);
                            }
                        } else if (platform === 'bedrock') {
                            let uuid = xuidToUuid(await usernameToXuid(username));

                            if (uuid === null) {
                                message = `Could not find that username (\`${username}\`), please check your username and spelling, then try again.`;
                            } else {
                                const rconResponse = await rcon.send(`fwhitelist add ${uuid}`);
                                if (rconResponse.includes('was already whitelisted')) { //Already whitelisted
                                    message = `\`${username}\` is already on the whitelist!`;
                                } else if (rconResponse.includes('has been added to the whitelist!')) { //Success
                                    message = `Success! \`${username}\` has been added to the whitelist.`;
                                    await conn.query('INSERT INTO `User` (`discord_id`, `mc_username`, `platform`, `mc_uuid`) VALUES (?, ?, "bedrock", ?);', [req.body.member.user.id, username, uuid]);
                                }
                            }
                        } else {
                            message = `Something went wrong, please react to \`Angel SMP Support\` in <@#${helpChannelID}> for help.`;
                        }
                    }

                    res.status(200).json({
                        'type': 4,
                        'data': {
                            'content': message,
                            'tts': false,
                            'flags': ephermeral ? 1 << 6 : 0 //64: Ephemeral
                        }
                    });

                    await conn.release();
                    break;
                default:
                    break;
            }
            break;
        case 3: //MESSAGE_COMPONENT

        // break;
        case 4: //APPLICATION_COMMAND_AUTOCOMPLETE

        // break;
        default:
            res.sendStatus(400);
            break;
    }

});


async function registerCommands() {
    const token = JSON.parse(await getToken());
    // debug(token);

    const guild_id = '266167522988916736';
    // const url = `https://discord.com/api/v8/applications/${APPLICATION_ID}/guilds/${guild_id}/commands`;
    // const url = `https://discord.com/api/v8/applications/${APPLICATION_ID}/commands`;

    const commands = [
        {
            // url: `https://discord.com/api/v8/applications/${APPLICATION_ID}/guilds/${guild_id}/commands`,
            url: `https://discord.com/api/v8/applications/${APPLICATION_ID}/commands`,
            command: {
                "name": "whitelist",
                "type": 1,
                "description": "Whitelist a minecraft username on the server",
                "options": [
                    {
                        "name": "username",
                        "description": "The username to whitelist",
                        "type": 3,
                        "required": true
                    },
                    {
                        "name": "platform",
                        "description": "Java or Bedrock?",
                        "choices": [
                            {
                                "name": "Java",
                                "value": "java"
                            },
                            {
                                "name": "Bedrock",
                                "value": "bedrock"
                            }
                        ],
                        "type": 3,
                        "required": true
                    }
                ]
            }
        }
    ];
    commands.forEach(async (command) => {
        let res = await request('POST', command.url, command.command, token.access_token);
        debug_out(res);
    });
    
    // res = await request('GET', url, null, token.access_token);
    // res = await request('DELETE', url+'/956686243205349457', null, token.access_token);
    // debug_out(res);
}
registerCommands().catch(reason => {
    console.error(reason);
});

function request(method, url, data, token) {
    return new Promise((resolve, reject) => {
        const options = {
            method: method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        };
        // debug(options);
        const req = https.request(url, options, function (resb) {
            debug_out('statusCode:', resb.statusCode);
            let data = '';
            resb.on('data', function (stream) {
                data += stream;
            });
            resb.on('end', async function () {
                resolve(data);
                // data = JSON.parse(data);
            });
        });
        debug_out(url);
        if (method === 'POST') {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

function getToken() {
    return new Promise((resolve, reject) => {
        const data = `grant_type=client_credentials&scope=identify%20connections%20applications.commands.update`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${new Buffer.from(`${APPLICATION_ID}:${CLIENT_SECRET}`).toString('base64')}`
            }
        };
        // debug(options);
        const req = https.request('https://discord.com/api/v8/oauth2/token', options, function (resb) {
            // debug('statusCode:', resb.statusCode);
            let data = '';
            resb.on('data', function (stream) {
                data += stream;
            });
            resb.on('end', async function () {
                resolve(data);
                // data = JSON.parse(data);
            });
        });
        // debug(url);
        req.write(data);
        req.end();
    });
}

async function setupRcon() {
    if (process.env.RCON_PASSWORD) {
        // debug(true);
        await rcon.connect(process.env.RCON_ADDRESS, process.env.RCON_PORT, process.env.RCON_PASSWORD);
        // console.log(await rcon.send('list'));
        // console.log(await runMinecraftCommand('list'));
    }
    // debug(false);
}

setupRcon().then(async () => {
    // let response = await rcon.send('whitelist add eletric99');
    // if (response.includes('player does not exist')) {
    //     debug('Could not find player');
    // }
    // debug(`RCON Response: ${response}`);
}).catch((reason) => {
    debug(`There was an RCON error: ${reason}`);
});

module.exports = router;
