const { ERC20, ERC20n, rpcMap, ethRpcArray,
    excludedMap } = require('./const');
const { Web3 } = require('web3');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// how many concurrent requests to make - different node may limit number of incoming requests - so 20 is a good compromise
// const asyncProcsNumber = 5;
const chains = [...rpcMap.keys()];
const chain = (process.env.CHAIN || chains[0]).toLowerCase();

function checkEthAddress(web3, address) {
    try {
        web3.utils.toChecksumAddress(address);
        return true;
    } catch (e) {
        return false;
    }
}
//
function parseAddress(web3, address) {
    const result = [];
    const list = address.split(/\n|;|,|;\n|,\n/)

    for (const l of list) {
        const name = l.trim()
        if (checkEthAddress(web3, name)) {
            result.push(name)
        }
    }

    return result.join('\n')
}

/**
 * Formats a number with commas (e.g. 123,234,660.12)
 *
 * @param {number} x - The number to be formatted.
 * @return {string} The formatted number as a string.
 */
function numberWithCommas(x) {
    if (x < 0.000001) return '0.00'
    const parts = x.toString().split(".")
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    if (parts.length > 1) {
        parts[1] = parts[1].substring(0, 2)
    }
    return parts.join(".")
}

/**
 * Retrieves information about a token using its contract address.
 *
 * @param {Object} web3 - The web3 instance.
 * @param {string} contractAddress - The contract address of the token.
 * @return {Object} An object containing token information.
 */
async function getTokenInfo(web3, contractAddress) {
    const token = new web3.eth.Contract(ERC20, contractAddress);

    // NOTE with web3 v4 it will not provide data auto field when calling contract method - and some nodes will fail to
    // process request without data field
    let ticker, validToken, decimals;

    try {
        ticker = await token.methods.symbol().call({data: '0x1'}); // ticker
        console.log(`"symbol" ticker: ${ticker}`)
        validToken = true;
    } catch (e) {
        // console.error(e);
    }

    if (!ticker) {
        try {
            ticker = await token.methods.ticker().call({data: '0x1'}); // ticker
            console.log(`"ticker" ticker: ${ticker}`)
            validToken = true;
        } catch (e) {
            // console.error(e);
        }
    }

    if (!ticker) {
        try {
            const tokenNonStd = new web3.eth.Contract(ERC20n, contractAddress);
            const symbol32 = await tokenNonStd.methods.symbol().call({data: '0x1'}); // ticker
            ticker = (web3.utils.hexToAscii(symbol32)).replaceAll(String.fromCharCode(0), '')
            console.log(`"bytes32" ticker: ${ticker}`)
            validToken = true;
        } catch (e) {
            // console.error(e);
            validToken = false;
            ticker = 'unknown';
        }
    }

    try {
        decimals = await token.methods.decimals().call({data: '0x1'}); // decimals
    } catch (e) {
        decimals = 18;
    }

    // getting price from 3rd party API - may have limits on number of requests
    let priceObj = {
        price: 0,
        USD: 0
    };

    if (validToken) {
        try {
            const req = (await fetch(`https://api-data.absolutewallet.com/api/v1/currencies/minimal/${chain}/${contractAddress}?fiat=USD`));
            if (req.status === 200) {
                priceObj = (await req.json());
            }
        } catch (e) {
            console.error(e);
        }

        if (priceObj.price === 0) {
            try {
                const req = (await fetch(`https://min-api.cryptocompare.com/data/price?fsym=${ticker}&tsyms=USD`));
                if (req.status === 200) {
                    priceObj = (await req.json());

                }
            } catch (e) {
                console.error(e);
            }
        }
    }

    return {
        address: contractAddress,
        ticker,
        valid: validToken,
        decimals: Number(decimals) || 18,
        price: priceObj['price'] ?? priceObj['USD'] ?? 0
    }
}

/**
 * Retrieves the balance of a given address for a specific token.
 *
 * @param {Token} token - The token contract instance.
 * @param {string} address - The address for which to retrieve the balance.
 * @return {Promise<number>} A promise that resolves to the balance of the address.
 */
async function getBalanceOf (token, address){
    return await token.methods.balanceOf(address).call({data: '0x1'}).catch(async () => {
        console.error(`balanceOf error: ${token._requestManager._provider.clientUrl}`);
        return await getBalanceOf(token, address);
    })
}


/**
 * Distributes tasks to workers in a round-robin fashion.
 * @async
 * @function distributeTasks
 * @param {Array} workers - An array of worker objects.
 * @param {Array} contractList - An array of contract objects to be distributed.
 * @returns {Promise<Array>} - A promise that resolves to an array of completed tasks.
 */
async function distributeTasks(workers, contractList) {
    const taskQueue = [...contractList]; // Copy of the original tasks array.
    const completedTasks = [];

    while (taskQueue.length > 0) {
        // Find the first available worker.
        const availableWorkerIndex = await findAvailableWorker(workers);

        if (availableWorkerIndex !== -1) {
            // Assign the next task to the available worker.
            const task = taskQueue.shift();
            const worker = workers[availableWorkerIndex];

            completedTasks.push(executeTask(worker, task));
        }
    }

    return await Promise.all(completedTasks);
}

/**
 * Finds the index of the first available worker in an array of worker objects.
 * @async
 * @function findAvailableWorker
 * @param {Array} workers - An array of worker objects.
 * @returns {Promise<number>} - A promise that resolves to the index of the first available worker.
 */
async function findAvailableWorker(workers) {
    return new Promise((resolve) => {
        const checkAvailability = () => {
            const index = workers.findIndex(worker => !worker.isBusy);

            if (index !== -1) {
                resolve(index);
            } else {
                setTimeout(checkAvailability, 10); // Check again in 100 milliseconds.
            }
        };

        checkAvailability();
    });
}


/**
 * Executes a task by assigning it to a worker and getting the balance of an Ethereum address using the worker's token.
 * @async
 * @function executeTask
 * @param {Object} worker - A worker object.
 * @param {string} address - An Ethereum address.
 * @returns {Promise<number>} - A promise that resolves to the balance of the Ethereum address.
 */
async function executeTask(worker, address) {
    return new Promise((resolve) => {
        worker.isBusy = true;
        // console.time(`getBalances: ${worker.token._requestManager._provider.clientUrl} ${address}`);
        getBalanceOf(worker.token, address).then((balance) => {
            worker.isBusy = false;
            // console.timeEnd(`getBalances: ${worker.token._requestManager._provider.clientUrl} ${address}`);
            resolve(balance);
        });
    });
}

/**
 * Retrieves all balances on multiple contracts for a given token.
 *
 * @param {Object} web3 - the web3 instance
 * @param {Array} contractList - the list of contract addresses to retrieve balances for
 * @param {Object} tokenObject - the token object containing token information
 * @return {Array} returns an array of records containing contract balances
 */
async function findBalances(web3, contractList, tokenObject) {
    const workers = [];

    if (chain === 'eth') {
        for (const rpc of ethRpcArray) {
            const web3provider = new Web3(rpc);
            workers.push({token: new web3provider.eth.Contract(ERC20, tokenObject.address), isBusy: false});
        }
    } else {
        workers.push({token: new web3.eth.Contract(ERC20, tokenObject.address), isBusy: false});
    }

    const balances = await distributeTasks(workers, contractList);
    // console.dir(balances);

    const records = []


    // format acquired balances
    for (let i = 0; i < balances.length; i++) {
        if (balances[i] > 0n) {
            const amount = Number(balances[i] / BigInt(Number(`1e${tokenObject.decimals}`)))
            const dollarValue = numberWithCommas(amount * tokenObject.price)
            records.push({
                amount: BigInt(balances[i]),
                roundedAmount: amount,
                dollarValue,
                contract: contractList[i]
            })
        }
    }

    // sort from max to min
    records.sort(function(a, b) {return b.roundedAmount - a.roundedAmount})

    return records
}


/**
 * Processes a single token by getting its information, finding its balances, and formatting the results.
 * @async
 * @function processOneToken
 * @param {Object} web3 - A Web3.js instance.
 * @param {Array} contractList - An array of contract objects.
 * @param {string} tokenAddress - The address of the token to be processed.
 * @returns {Promise<Object>} - A promise that resolves to an object containing the processed token information.
 */
async function processOneToken(web3, contractList, tokenAddress) {
    const tokenObject = await getTokenInfo(web3, tokenAddress)

    let localList = [...contractList];

    // exclude unneeded contracts
    if (excludedMap.has(tokenAddress)) {
        const excluded = excludedMap.get(tokenAddress);
        for (let ex of excluded) {
            const index = localList.indexOf(ex);
            if (index > -1) { // only splice array when item is found
                localList.splice(index, 1); // 2nd parameter means remove one item only
            }
        }
    }
    // console.dir(tokenObject);

    if (!tokenObject.valid) {
        return {
            tokenAddress,
            price: 0,
            decimals: 18,
            ticker: null,
            records: []
        }
    }

    const results = await findBalances(web3, localList, tokenObject);

    return {
        tokenAddress,
        ticker: tokenObject.ticker,
        decimals: tokenObject.decimals,
        price: tokenObject.price,
        records: results
    }
}


/**
 * Formats the result of a token balance check.
 * @function formatTokenResult
 * @param {Object} res - An object containing the result of a token balance check.
 * @returns {Object} - An object containing the formatted result string and the value in dollars.
 */
function formatTokenResult(res) {
    let localStr = ''

    if (!res.ticker) { // invalid token
        return { resStr : `??? [${res.tokenAddress}] - unknown token\n`, asDollar: 0 }
    }

    if (res.price === -1) { // can't get price
        return { resStr : `${res.ticker} [${res.tokenAddress}]: not checked - no price found\n`, asDollar: 0 }
    }

    // normal process
    let sum = 0n

    // records already sorted by value - formatting output
    for (const record of res.records) {
        const str = `Contract ${record.contract} => ${numberWithCommas(record.roundedAmount)} ${res.ticker} ( $${record.dollarValue} )`
        sum += record.amount
        localStr += str + '\n'
    }

    // increasing sum value
    const roundedAmount = Number(sum) / Number(`1e${res.decimals}`)
    const asDollar = roundedAmount * res.price

    const header = `${res.ticker} [${res.tokenAddress}]: ${numberWithCommas(roundedAmount)} tokens lost / $${numberWithCommas(asDollar)}`
    localStr = header + '\n-----------------------------------------------\n' + localStr

    return { resStr: localStr, asDollar }
}

module.exports = {
    getTokenInfo,
    getBalanceOf,
    findBalances,
    processOneToken,
    formatTokenResult,
    parseAddress,
    numberWithCommas
}