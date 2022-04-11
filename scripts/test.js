require('dotenv').config({ path: '../.env' });

const mariadb = require('mariadb');
const debug = require('debug')('discord-whitelist:test');
const https = require('https');
const Rcon = require('../node-rcon/RCON');
const { rejects } = require('assert');

const rcon = new Rcon();


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

async function init2() {
    await rcon.connect(process.env.RCON_ADDRESS, process.env.RCON_PORT, process.env.RCON_PASSWORD);
    // const rconResponse = await rcon.send(`fwhitelist add 00000000-0000-0000-0009-01fdebad513c`);
    const rconResponse = await rcon.send(`fwhitelist add 00000000-0000-0000-0009-01fde000013c`);
    rcon.end();
    debug(rconResponse);

    // const username = 'eletric99sssss4172';
    // let uuid = xuidToUuid(await usernameToXuid(username));
    // debug(uuid);
}

init2();
