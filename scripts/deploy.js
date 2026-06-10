const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Deploying FlashLoanArb contract...\n");

  // Morpho Blue addresses (same on all supported chains)
  const MORPHO_ADDRESSES = {
    base: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    ethereum: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    arbitrum: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  };

  // Get the network name
  const network = hre.network.name;
  console.log(`📡 Deploying to ${network}...`);

  // Check if we're on a supported network
  if (!MORPHO_ADDRESSES[network]) {
    console.error(`❌ Unsupported network: ${network}`);
    console.log(
      `Supported networks: ${Object.keys(MORPHO_ADDRESSES).join(", ")}`,
    );
    process.exit(1);
  }

  const morphoAddress = MORPHO_ADDRESSES[network];
  console.log(`📍 Morpho Blue address: ${morphoAddress}`);

  // Get the contract factory
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");

  // Deploy the contract
  console.log("🚀 Deploying FlashLoanArbitrage...");
  const contract = await FlashLoanArbitrage.deploy(morphoAddress);

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log(`✅ FlashLoanArb deployed to ${contractAddress}`);
  console.log(`   Network: ${network}`);
  console.log(`   Morpho: ${morphoAddress}`);
  console.log(
    `   Deployer: ${(await hre.ethers.provider.getSigner()).address}`,
  );

  // Save deployment info to a JSON file
  const deploymentsDir = path.join(__dirname, "../deployments");

  // Create deployments directory if it doesn't exist
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save deployment info
  const deploymentInfo = {
    network: network,
    chainId:
      hre.network.config.chainId ||
      (await hre.ethers.provider.getNetwork()).chainId,
    contractAddress: contractAddress,
    morphoAddress: morphoAddress,
    deployer: (await hre.ethers.provider.getSigner()).address,
    deploymentBlock: await hre.ethers.provider.getBlockNumber(),
    timestamp: new Date().toISOString(),
    transactionHash: contract.deploymentTransaction()?.hash || "unknown",
  };

  const deploymentFile = path.join(deploymentsDir, `${network}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`💾 Deployment info saved to deployments/${network}.json`);

  // Also update .env file with the contract address
  updateEnvFile(network, contractAddress);

  // Verify the contract on Etherscan/BaseScan if not on localhost
  if (network !== "hardhat" && network !== "localhost") {
    console.log("\n🔍 Waiting for a few blocks before verification...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [morphoAddress],
      });
      console.log("✅ Contract verified on explorer");
    } catch (error) {
      console.log("⚠️ Contract verification failed:", error.message);
      console.log("You can verify manually with:");
      console.log(
        `npx hardhat verify --network ${network} ${contractAddress} ${morphoAddress}`,
      );
    }
  }

  // Print useful information
  console.log("\n📋 Next Steps:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`1. Update your .env file with:`);
  console.log(`   CONTRACT_${network.toUpperCase()}=${contractAddress}`);
  console.log("");
  console.log("2. Run the bot with:");
  console.log("   npm start");
  console.log("");
  console.log("3. Monitor the contract with:");
  console.log(`   https://basescan.org/address/${contractAddress} (Base)`);
  console.log(`   https://etherscan.io/address/${contractAddress} (Ethereum)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

// Helper function to update .env file
function updateEnvFile(network, contractAddress) {
  const envPath = path.join(__dirname, "../.env");
  const envExamplePath = path.join(__dirname, "../.env.example");

  // Create .env.example if it doesn't exist
  if (!fs.existsSync(envExamplePath)) {
    const exampleContent = `# Flash Loan Arbitrage Bot Configuration
PRIVATE_KEY=your_private_key_here

# RPC URLs
BASE_RPC_URL=https://mainnet.base.org
ETH_RPC_URL=https://eth.llamarpc.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc

# Contract Addresses
CONTRACT_BASE=0x...
CONTRACT_ETH=0x...
CONTRACT_ARBITRUM=0x...

# Optional: Flashbots for Ethereum
FLASHBOTS_RPC=https://rpc.flashbots.net
`;
    fs.writeFileSync(envExamplePath, exampleContent);
    console.log("📝 Created .env.example file");
  }

  // Update or create .env file
  let envContent = {};

  if (fs.existsSync(envPath)) {
    // Read existing .env file
    const existingContent = fs.readFileSync(envPath, "utf8");
    existingContent.split("\n").forEach((line) => {
      const [key, value] = line.split("=");
      if (key && value && !key.startsWith("#")) {
        envContent[key.trim()] = value.trim();
      }
    });
  }

  // Update the contract address
  const envKey = `CONTRACT_${network.toUpperCase()}`;
  envContent[envKey] = contractAddress;

  // Write back to .env file
  let newEnvContent = "";
  for (const [key, value] of Object.entries(envContent)) {
    newEnvContent += `${key}=${value}\n`;
  }

  fs.writeFileSync(envPath, newEnvContent);
  console.log(`📝 Updated .env with ${envKey}=${contractAddress}`);

  // Also add RPC URL if missing
  if (!envContent[`${network.toUpperCase()}_RPC_URL`]) {
    const rpcUrls = {
      base: "BASE_RPC_URL=https://mainnet.base.org",
      ethereum: "ETH_RPC_URL=https://eth.llamarpc.com",
      arbitrum: "ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc",
    };

    if (rpcUrls[network]) {
      fs.appendFileSync(envPath, `\n${rpcUrls[network]}\n`);
      console.log(`📝 Added ${rpcUrls[network]} to .env`);
    }
  }
}

// Handle errors
main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
