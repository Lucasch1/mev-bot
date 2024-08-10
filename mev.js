// This is a basic uniswap frontrunning MEV bot
// Made by Merunas follow me on youtube to see how to use it and edit it: https://www.youtube.com/channel/UCJInIwgW1duAEnMHHxDK7XQ

// 1. Setup ethers, required variables, contracts and start function
const { Wallet, ethers } = require("ethers");
const {
    FlashbotsBundleProvider,
    FlashbotsBundleResolution,
} = require("@flashbots/ethers-provider-bundle");

require("dotenv").config();

const {
    erc20Abi,
    erc20Bytecode,
    uniswapV3Abi,
    UniswapAbi,
    UniswapBytecode,
    UniswapFactoryAbi,
    UniswapFactoryBytecode,
    pairAbi,
    pairBytecode,
} = require("./abis");

const flashbotsUrl = process.env.FLASHBOTS_URL;
const wethAddress = process.env.WETH_ADDRESS;
const uniswapAddress = process.env.UNISWAP_ADDRESS;
const uniswapFactoryAddress = process.env.UNISWAP_FACTORY_ADDRESS;
const universalRouterAddress = process.env.UNIVERSAL_ROUTER_ADDRESS;
const httpProviderUrl = process.env.HTTP_PROVIDER_URL;
const wsProviderUrl = process.env.WS_PROVIDER_URL;
const privateKey = process.env.PRIVATE_KEY;

// 1.1 Setup ABIs and Bytecodes

// 1.2 Setup user modifiable variables
const bribeToMiners = ethers.parseUnits("20", "gwei");
const buyAmount = ethers.parseUnits("0.1", "ether");
const chainId = 11155111;

const provider = new ethers.JsonRpcProvider(httpProviderUrl);
const wsProvider = new ethers.WebSocketProvider(wsProviderUrl);

// 1.3 Setup contracts and providers
const signingWallet = new Wallet(privateKey).connect(provider);
const uniswapV3Interface = new ethers.Interface(uniswapV3Abi);
const factoryUniswapFactory = new ethers.ContractFactory(
    UniswapFactoryAbi,
    UniswapFactoryBytecode,
    signingWallet
).attach(uniswapFactoryAddress);
const erc20Factory = new ethers.ContractFactory(
    erc20Abi,
    erc20Bytecode,
    signingWallet
);
const pairFactory = new ethers.ContractFactory(
    pairAbi,
    pairBytecode,
    signingWallet
);
const uniswap = new ethers.ContractFactory(
    UniswapAbi,
    UniswapBytecode,
    signingWallet
).attach(uniswapAddress);
let flashbotsProvider = null;

// 2. Create the start function to listen to transactions
// 2.5. Decode uniswap universal router transactions
const decodeUniversalRouterSwap = (input) => {
    const abiCoder = new ethers.AbiCoder();
    const decodedParameters = abiCoder.decode(
        ["address", "uint256", "uint256", "bytes", "bool"],
        input
    );
    const breakdown = input.substring(2).match(/.{1,64}/g);

    let path = [];
    let hasTwoPath = true;
    if (breakdown.length != 9) {
        const pathOne = "0x" + breakdown[breakdown.length - 2].substring(24);
        const pathTwo = "0x" + breakdown[breakdown.length - 1].substring(24);
        path = [pathOne, pathTwo];
    } else {
        hasTwoPath = false;
    }

    return {
        recipient: parseInt(decodedParameters[(0, 16)]),
        amountIn: decodedParameters[1],
        minAmountOut: decodedParameters[2],
        path,
        hasTwoPath,
    };
};

// 3. Setup initial checks
const initialChecks = async (tx) => {
    let transaction = null;
    let decoded = null;
    let decodedSwap = null;

    try {
        transaction = await provider.getTransaction(tx);
    } catch (e) {
        return false;
    }

    if (!transaction || !transaction.to) return false;
    if (Number(transaction.value) == 0) return false;
    if (transaction.to.toLowerCase() != universalRouterAddress.toLowerCase()) {
        return false;
    }

    try {
        decoded = uniswapV3Interface.parseTransaction(transaction);
    } catch (e) {
        return false;
    }

    // If the swap is not for uniswapV2 we return it
    if (!decoded.args.commands.includes("08")) return false;
    let swapPositionInCommands =
        decoded.args.commands.substring(2).indexOf("08") / 2;
    let inputPosition = decoded.args.inputs[swapPositionInCommands];
    decodedSwap = decodeUniversalRouterSwap(inputPosition);
    if (!decodedSwap.hasTwoPath) return false;
    if (decodedSwap.recipient === 2) return false;
    if (decodedSwap.path[0].toLowerCase() != wethAddress.toLowerCase())
        return false;

    return {
        transaction,
        amountIn: transaction.value,
        minAmountOut: decodedSwap.minAmountOut,
        tokenToCapture: decodedSwap.path[1],
    };
};

// 4. Process transaction
const processTransaction = async (tx) => {
    const checksPassed = await initialChecks(tx);
    if (!checksPassed) return false;
    const {
        transaction,
        amountIn, // Victim's ETH
        minAmountOut,
        tokenToCapture,
    } = checksPassed;

    console.log("checks passed", tx);

    // 5. Get and sort the reserves
    const pairAddress = await factoryUniswapFactory.getPair(
        wethAddress,
        tokenToCapture
    );
    const pair = pairFactory.attach(pairAddress);

    let reserves = null;
    try {
        reserves = await pair.getReserves();
    } catch (e) {
        return false;
    }

    let a;
    let b;
    if (wethAddress < tokenToCapture) {
        a = reserves._reserve0;
        b = reserves._reserve1;
    } else {
        a = reserves._reserve1;
        b = reserves._reserve0;
    }

    // 6. Get fee costs for simplicity we'll add the user's gas fee
    const maxGasFee = transaction.maxFeePerGas
        ? transaction.maxFeePerGas.add(bribeToMiners)
        : bribeToMiners;
    const priorityFee = transaction.maxPriorityFeePerGas
        ? transaction.maxPriorityFeePerGas.add(bribeToMiners)
        : bribeToMiners;

    // 7. Buy using your amount in and calculate amount out
    let firstAmountOut = await uniswap.getAmountOut(buyAmount, a, b);
    const updatedReserveA = a.add(buyAmount);
    const updatedReserveB = b.add(firstAmountOut.mul(997).div(1000));
    let secondBuyAmount = await uniswap.getAmountOut(
        amountIn,
        updatedReserveA,
        updatedReserveB
    );

    console.log("secondBuyAmount", secondBuyAmount.toString());
    console.log("minAmountOut", minAmountOut.toString());
    if (secondBuyAmount.lt(minAmountOut))
        return console.log("Victim would get less than the minimum");
    const updatedReserveA2 = updatedReserveA.add(amountIn);
    const updatedReserveB2 = updatedReserveB.add(
        secondBuyAmount.mul(997).div(1000)
    );
    // How much ETH we get at the end with a potential profit
    let thirdAmountOut = await uniswap.getAmountOut(
        firstAmountOut,
        updatedReserveB2,
        updatedReserveA2
    );

    // 8. Prepare first transaction
    const deadline = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now
    let firstTransaction = {
        signer: signingWallet,
        transaction: await uniswap.populateTransaction.swapExactETHForTokens(
            firstAmountOut,
            [wethAddress, tokenToCapture],
            signingWallet.address,
            deadline,
            {
                value: buyAmount,
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    };
    firstTransaction.transaction = {
        ...firstTransaction.transaction,
        chainId,
    };

    // 9. Prepare second transaction
    const victimsTransactionWithChainId = {
        chainId,
        ...transaction,
    };
    const signedMiddleTransaction = {
        signedTransaction: ethers.utils.serializeTransaction(
            victimsTransactionWithChainId,
            {
                r: victimsTransactionWithChainId.r,
                s: victimsTransactionWithChainId.s,
                v: victimsTransactionWithChainId.v,
            }
        ),
    };

    // 10. Prepare third transaction for the approval
    const erc20 = erc20Factory.attach(tokenToCapture);
    let thirdTransaction = {
        signer: signingWallet,
        transaction: await erc20.populateTransaction.approve(
            uniswapAddress,
            firstAmountOut,
            {
                value: "0",
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    };
    thirdTransaction.transaction = {
        ...thirdTransaction.transaction,
        chainId,
    };

    // 11. Prepare the last transaction to get the final eth
    let fourthTransaction = {
        signer: signingWallet,
        transaction: await uniswap.populateTransaction.swapExactTokensForETH(
            firstAmountOut,
            thirdAmountOut,
            [tokenToCapture, wethAddress],
            signingWallet.address,
            deadline,
            {
                value: "0",
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    };
    fourthTransaction.transaction = {
        ...fourthTransaction.transaction,
        chainId,
    };
    const transactionsArray = [
        firstTransaction,
        signedMiddleTransaction,
        thirdTransaction,
        fourthTransaction,
    ];
    const signedTransactions = await flashbotsProvider.signBundle(
        transactionsArray
    );
    const blockNumber = await provider.getBlockNumber();
    console.log("Simulating...");
    const simulation = await flashbotsProvider.simulate(
        signedTransactions,
        blockNumber + 1
    );
    if (simulation.firstRevert) {
        return console.log("Simulation error", simulation.firstRevert);
    } else {
        console.log("Simulation success", simulation);
    }

    // 12. Send transactions with flashbots
    let bundleSubmission;
    flashbotsProvider
        .sendRawBundle(signedTransactions, blockNumber + 1)
        .then((_bundleSubmission) => {
            bundleSubmission = _bundleSubmission;
            console.log("Bundle submitted", bundleSubmission.bundleHash);
            return bundleSubmission.wait();
        })
        .then(async (waitResponse) => {
            console.log(
                "Wait response",
                FlashbotsBundleResolution[waitResponse]
            );
            if (waitResponse == FlashbotsBundleResolution.BundleIncluded) {
                console.log("-------------------------------------------");
                console.log("-------------------------------------------");
                console.log("----------- Bundle Included ---------------");
                console.log("-------------------------------------------");
                console.log("-------------------------------------------");
            } else if (
                waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh
            ) {
                console.log("The transaction has been confirmed already");
            } else {
                console.log("Bundle hash", bundleSubmission.bundleHash);
                try {
                    console.log({
                        bundleStats: await flashbotsProvider.getBundleStats(
                            bundleSubmission.bundleHash,
                            blockNumber + 1
                        ),
                        userStats: await flashbotsProvider.getUserStats(),
                    });
                } catch (e) {
                    return false;
                }
            }
        });
};

const start = async () => {
    flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        signingWallet,
        flashbotsUrl
    );
    console.log("Listening on transaction for the chain id", chainId);
    wsProvider.on("pending", (tx) => {
        // console.log('tx', tx)
        processTransaction(tx);
    });
};

start();

// Next steps:
// - Calculate gas costs
// - Estimate the next base fee
// - Calculate amounts out locally
// - Use multiple block builders besides flashbots
// - Reduce gas costs by using an assembly yul contract
// - Use multiple cores from your computer to improve performance
// - Calculate the transaction array for type 0 and type 2 transactions
// - Implement multiple dexes like uniswap, shibaswap, sushiswap and others
// - Calculate the pair address locally with a function without a blockchain request
// - Calculate the exact amount you'll get in profit after the first, middle and last trade without a request and without loops
