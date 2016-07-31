# PokeGo-Slave
Yet another Pokemon Go bot, built using Node.js and express.js to serve the web client UI.

# Disclaimer
This is created for educational purpose. I use this project to uderstand the underlying method of data trasfer used in games. Specifically data enveloping methods.
I also use this to learn my understanding about automation process.
Use it as you see fit. I do not held any responsibility of this project usage.

# How to use
Prerequisites:
- Make sure you have Node.js and npm installed.
- Also make sure you have node-gyp prerequisites installed. For information for your system, go here https://github.com/nodejs/node-gyp
- Clone this project.
- Navigate to it's root directory.
- Run 'npm install' to install depencencies.

Usage:
- Edit ./bot/Settings.json as you see fit. The guide are bellow this section. 
- Run 'node /bin/www' to run the bot. You can navigate to 'http://localhost:3000/' to see the GUI report.
- Or better yet, just run './start' on *nix platforms or 'start.bat' on Windows.

#Settings
Here are the settings' explanation:
- username : This is your username. Either PTC or Google account.
- password : Your password. For Google account who activated multi-factor authentication, create app password. How? Ask Google.. :3
- provider : Your account provider. This should be "google" or "ptc".
- centerType : The type center of your operation coverage. Can be "coords" for lat-long coordinate, or "name" for named places like "Central Park" for example.
- centerName : Fill your center location name, e.g: "Central Park". You can omit or use empty string if your type is "coords".
- centerLatitude : Your center's latitude.
- centerLongitude : Your center's longitude.
- centerAltitude : Your center's altitude. I usually just use 0.. :3
- radius : Your operation radius. Your character will not walking outside of this circle.
- loopInterval: Your operation interval in milliseconds. 2000 should be safe for now. Less than that, and they will throttle you.
- step: Your character step distance in meter. Note that this is related with the loop interval. In the default value, this means 5 meter for 2 seconds (a.k.a 2.5m/s).
- ball: Your ball to use. 1 = Pokeball, 2 = Great Ball, 3 = Ultra Ball, 4 = Master Ball.
- movement: Your character movement. For now, it support "none", if you want your character standstill, and "random" for random destination walks.
- collect: Define whether you want to collect items from PokeStop. true = collect, false = ignore the pokestop.
- encounter: Same with collect, but for wild pokemons. true = catch, false = let them be.
- target: Your catch target preference. Supporting "all" for catch all of them, "except" for catch all except for the one specified, "only" for catch only specified pokemons.
- specificTargets: List of pokemon's name for target.

That's it. :3

#Additional information
Regarding s2geometry-node issue (specially in Windows), just make sure you have install the build tools at the link above. 
If your still have error on building it, try update your npm with 'npm install -g npm@next' with Administrator credentials.