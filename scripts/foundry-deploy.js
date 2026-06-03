const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const network = process.argv[2] || "base";

  console.log(
    `🚀 Deploying FlashLoanArbitrage to ${network} using Foundry...\n`,
  );

  // Check if PRIVATE_KEY is set
  if (!process.env.PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY not set in .env file");
    process.exit(1);
  }

  try {
    // Deploy using forge script
    console.log(`📡 Deploying to ${network}...`);

    const deployCmd = `forge script script/DeployFlashLoanArb.s.sol:DeployFlashLoanArb \
      --rpc-url ${network} \
      --broadcast \
      --verify \
      --private-key ${process.env.PRIVATE_KEY} \
      -vvvv`;

    console.log("Running deployment...");
    execSync(deployCmd, { stdio: "inherit", cwd: path.join(__dirname, "..") });

    // Read deployment info
    const deploymentFile = path.join(
      __dirname,
      "../deployments",
      `${network}.json`,
    );

    if (fs.existsSync(deploymentFile)) {
      const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

      console.log("\n✅ Deployment successful!");
      console.log(`   Contract: ${deployment.contractAddress}`);
      console.log(`   Network: ${deployment.network}`);
      console.log(`   Morpho: ${deployment.morphoAddress}`);

      // Update .env file
      updateEnvFile(network, deployment.contractAddress);

      console.log("\n📋 Next Steps:");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(
        `1. Update .env file with CONTRACT_${network.toUpperCase()}=${deployment.contractAddress}`,
      );
      console.log("\n2. Run the price monitor:");
      console.log("   node scripts/priceMonitor.js");
      console.log("\n3. Run the execution engine:");
      console.log("   node scripts/executionEngine.js");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
  } catch (error) {
    console.error("❌ Deployment failed:", error.message);
    process.exit(1);
  }
}

function updateEnvFile(network, contractAddress) {
  const envPath = path.join(__dirname, "../.env");
  let envContent = {};

  if (fs.existsSync(envPath)) {
    const existingContent = fs.readFileSync(envPath, "utf8");
    existingContent.split("\n").forEach((line) => {
      const [key, value] = line.split("=");
      if (key && value && !key.startsWith("#")) {
        envContent[key.trim()] = value.trim();
      }
    });
  }

  envContent[`CONTRACT_${network.toUpperCase()}`] = contractAddress;

  let newEnvContent = "";
  for (const [key, value] of Object.entries(envContent)) {
    newEnvContent += `${key}=${value}\n`;
  }

  fs.writeFileSync(envPath, newEnvContent);
  console.log(
    `📝 Updated .env with CONTRACT_${network.toUpperCase()}=${contractAddress}`,
  );
}

// Run the deployment
main().catch(console.error);
