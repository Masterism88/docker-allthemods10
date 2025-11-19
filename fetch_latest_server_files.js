import { createRequire } from 'module';
import * as fs from 'fs/promises';
import { existsSync, createWriteStream, createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { CurseForgeClient } from 'curseforge-api';
import * as unzipper from 'unzipper';

// --- CONFIGURATION: REPLACE THESE VALUES ---
// You need to find your modpack ID on CurseForge. It's in the URL:
// https://www.curseforge.com/minecraft/modpacks/YOUR-MODPACK-SLUG/files/all?filter-game-version=1_20_1
const MODPACK_ID = 925200; // Example: ID for "All The Mods 8 - ATM8"
const MINECRAFT_VERSION = '1.21'; // Example: The target Minecraft version for the server files
// ------------------------------------------

// Recreate 'require' for compatibility with unzipper
//const require = createRequire(import.meta.url);
//const unzipper = require('unzipper');

// Use environment variable for API Key
const CURSEFORGE_API_KEY = process.env.CURSEFORGE_API_KEY;

if (!CURSEFORGE_API_KEY) {
  console.error("FATAL: CURSEFORGE_API_KEY environment variable is not set.");
  process.exit(1);
}

const api = new CurseForgeClient(
    CURSEFORGE_API_KEY,
    { fetch: fetch }
);
const TEMP_DIR = './temp_server_files';
const SERVER_FILE_NAME = 'server-files.zip';
const LAUNCH_SH_PATH = 'launch.sh';
const DOCKERFILE_PATH = 'Dockerfile';

/**
 * Finds the latest server file for the specified modpack and Minecraft version.
 * @returns {object} The file details object.
 */
async function findLatestServerFile() {
    console.log(`Searching for latest server file for Modpack ID ${MODPACK_ID} on Minecraft ${MINECRAFT_VERSION}...`);
    
    // Get all files for the modpack
    const response = await api.getModFiles(MODPACK_ID);
    
    // Access the files array from the 'data' property of the response object (The fix)
    const files = response.data; 

    // CHECK: Ensure 'files' is an array before attempting to use filter()
    if (!Array.isArray(files)) {
        throw new Error(`CurseForge API response did not contain an array of files in the 'data' property. Received type: ${typeof files}`);
    }

    // Find the latest file that is marked as a 'Server Pack' and matches the game version
    const serverFile = files
        .filter(file => {
            // --- THE FIX: Check for the existence of the property first ---
            if (!file.gameVersion) {
                return false; // Skip this file if gameVersion is undefined
            }
            
            // Now safely check for server pack and game version inclusion
            return file.serverPackFileId && file.gameVersion.includes(MINECRAFT_VERSION);
        })
        .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))[0];

    if (!serverFile) {
        throw new Error(`Could not find a server file for modpack ID ${MODPACK_ID} and Minecraft version ${MINECRAFT_VERSION}.`);
    }

    // Get the details of the server pack file (which contains the download URL)
    const serverPackFile = await api.getFile(MODPACK_ID, serverFile.serverPackFileId);
    
    console.log(`Found latest server version: ${serverFile.displayName} (Server File ID: ${serverFile.serverPackFileId})`);
    
    // Return the server file object and the modpack version (which is often the file name without extension)
    return {
        downloadUrl: serverPackFile.downloadUrl,
        modpackVersion: serverFile.fileName.replace(/\.zip$/, ''),
        fileName: serverFile.fileName,
        displayName: serverFile.displayName
    };
}

/**
 * Downloads the server file zip from the given URL.
 * @param {string} url The download URL.
 * @param {string} outputPath The path to save the zip file.
 */
async function downloadFile(url, outputPath) {
    console.log(`Downloading server files from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
    }
    
    const fileStream = createWriteStream(outputPath);
    await new Promise((resolve, reject) => {
        response.body.pipe(fileStream);
        response.body.on("error", reject);
        fileStream.on("finish", resolve);
    });
    console.log(`Download complete. Saved to ${outputPath}`);
}

/**
 * Extracts the contents of the zip file into the temporary directory.
 * This is crucial for retrieving the actual server JAR and version info.
 */
async function extractServerFiles() {
    console.log(`Extracting ${SERVER_FILE_NAME} to ${TEMP_DIR}...`);
    const zipPath = path.join(TEMP_DIR, SERVER_FILE_NAME);
    const directory = await unzipper.Open.file(zipPath);
    await directory.extract({ path: TEMP_DIR, concurrency: 5 });
    console.log('Extraction complete.');
}

/**
 * Updates the SERVER_VERSION in launch.sh and the server file name in Dockerfile.
 * @param {string} modpackVersion The new modpack version.
 */
async function updateRepoFiles(modpackVersion) {
    const serverJarFile = await findServerJarInTempDir();
    if (!serverJarFile) {
        console.warn("Could not find server JAR file in extracted files. Skipping Dockerfile update.");
    }

    // 1. Update launch.sh
    console.log(`Updating ${LAUNCH_SH_PATH} with SERVER_VERSION=${modpackVersion}`);
    let launchShContent = await fs.readFile(LAUNCH_SH_PATH, 'utf-8');
    // Replace the line that starts with 'SERVER_VERSION='
    const newLaunchShContent = launchShContent.replace(
        /^SERVER_VERSION=.*$/m,
        `SERVER_VERSION=${modpackVersion}`
    );
    await fs.writeFile(LAUNCH_SH_PATH, newLaunchShContent);

    // 2. Update Dockerfile (if server jar was found)
    if (serverJarFile && existsSync(DOCKERFILE_PATH)) {
        console.log(`Updating ${DOCKERFILE_PATH} with new server JAR file: ${serverJarFile}`);
        let dockerfileContent = await fs.readFile(DOCKERFILE_PATH, 'utf-8');
        // Replace a line that typically copies the server JAR, assuming a common Dockerfile structure
        const newDockerfileContent = dockerfileContent.replace(
            /^(COPY|ADD)\s+[^ ]+\.(jar|sh)\s+.*$/m, // A simple regex to catch a file copy operation
            `COPY ${serverJarFile} /server/minecraft_server.jar` // Example replacement
        );
        await fs.writeFile(DOCKERFILE_PATH, newDockerfileContent);
    } else if (serverJarFile) {
         console.warn(`${DOCKERFILE_PATH} not found. Skipping Dockerfile update.`);
    }
}

/**
 * Searches the TEMP_DIR for the main server JAR file.
 * @returns {string|null} The filename of the server JAR, or null if not found.
 */
async function findServerJarInTempDir() {
    try {
        const files = await fs.readdir(TEMP_DIR);
        // Look for common server JAR files like 'forge-*.jar', 'fabric-*.jar', 'server.jar'
        const serverJar = files.find(file => 
            file.endsWith('.jar') && 
            !file.includes('installer') && 
            !file.includes('client')
        );
        return serverJar || null;
    } catch (error) {
        console.error("Error reading temporary directory:", error);
        return null;
    }
}

/**
 * Main function to run the update process.
 */
async function main() {
    try {
        // 1. Prepare environment
        await fs.mkdir(TEMP_DIR, { recursive: true });

        // 2. Find file details
        const serverFileInfo = await findLatestServerFile();
        
        // 3. Download the file
        const zipPath = path.join(TEMP_DIR, SERVER_FILE_NAME);
        await downloadFile(serverFileInfo.downloadUrl, zipPath);
        
        // 4. Extract the contents
        await extractServerFiles();

        // 5. Update repo files
        await updateRepoFiles(serverFileInfo.modpackVersion);

    } catch (error) {
        console.error('An error occurred during the update process:', error.message);
        process.exit(1);
    } finally {
        // 6. Clean up
        if (existsSync(TEMP_DIR)) {
            console.log(`Cleaning up temporary directory: ${TEMP_DIR}`);
            // Use 'rm' command for recursive deletion (safer in a workflow context)
            await fs.rm(TEMP_DIR, { recursive: true, force: true });
        }
    }
}

main();