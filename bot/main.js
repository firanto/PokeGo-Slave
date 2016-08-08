'use strict';

const Promise = require("bluebird");
const Geolib = require('geolib');
const dateFormat = require('dateformat');
const log4js = require('log4js');
const fs = require('fs');
const Long = require('long');

const pogobuf = require('pogobuf');
const POGOProtos = require('node-pogo-protos');

// temporary requirement
const utils = require('./utils.js');

// load settings data
const PokemonList = JSON.parse(fs.readFileSync(__dirname + '/pokemons.json', 'utf8')).pokemon;
const ItemList = JSON.parse(fs.readFileSync(__dirname + '/items.json', 'utf8'));

// settings must be var because we inject second layer setting item on the fly
var Settings = JSON.parse(fs.readFileSync(__dirname + '/settings.json', 'utf8'));

log4js.configure({ appenders: [ { type: 'console' }, { type: 'file', filename: 'logs/log ' + dateFormat(new Date(), "yyyy-mm-dd h-MM-ss") + '.log', category: 'PokeGoSlave' } ]});

// Extend Number object with method to convert radians to numeric (signed) degrees 
if (Number.prototype.toDegrees === undefined) {
    Number.prototype.toDegrees = function() { return this * 180 / Math.PI; };
}

// helper functions
function numberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Main object declaration
var PokeGoWorker = function () {
    var self = this;
    self.logger = log4js.getLogger('PokeGoSlave');
    self.login = null;
    self.client = null;

    // socket.io object
    self.io = null;

    // local settings
    self.initialCleanup = true;
    self.noResultCounter = 0;
    self.noResultLastOccurence = null;

    // run and loop state
    self.started = false;
    self.doLoop = false;

    // character data
    self.character = {
        username: '',
        team: '',
        level: 0,
        experience: 0,
        nextExperience: 0,
        kmWalked: 0,
        pokeStorage: 0,
        itemStorage: 0,
        totalItems: 0,
        pokeCoin: 0,
        stardust: 0,
        location: {
            name: '',
            latitude: Settings.centerLatitude,
            longitude: Settings.centerLongitude,
            altitude: Settings.centerAltitude
        },
        pokemons: [],
        pokemonFamilies: [],
        eggs: [],
        candies: [],
        items: [],
        captives: []
    }

    self.hbData = {
        location: self.character.location,
        pokeStops: [],
        gyms: [],
        catchablePokemons: [],
        nearbyPokemons: [],
        wildPokemons: []
    };

    self.destination = null;
    self.collectedPokeStops = [];
    self.transferingPokemons = [];

    self.transferSpecific = [];
    Settings.pokemonKeepSpecific.forEach(keep => {
        var pokemon = PokemonList.find(pokemon => {
            return pokemon.name.toLowerCase() == keep.name.toLowerCase();
        });
        self.transferSpecific.push({ pokemonId: parseInt(pokemon.id), limit: keep.limit });
    });

    self.specificTargets = [];
    Settings.specificTargets.forEach(target => {
        var pokemon = PokemonList.find(pokemon => {
            return pokemon.name.toLowerCase() == target.toLowerCase();
        });
        self.specificTargets.push(pokemon);
    });

    self.generateBarrier = function () {
        var center = { latitude: Settings.centerLatitude, longitude: Settings.centerLongitude };
        return [
            Geolib.computeDestinationPoint(center, Settings.radius, 0),
            Geolib.computeDestinationPoint(center, Settings.radius, 30),
            Geolib.computeDestinationPoint(center, Settings.radius, 60),
            Geolib.computeDestinationPoint(center, Settings.radius, 90),
            Geolib.computeDestinationPoint(center, Settings.radius, 120),
            Geolib.computeDestinationPoint(center, Settings.radius, 150),
            Geolib.computeDestinationPoint(center, Settings.radius, 180),
            Geolib.computeDestinationPoint(center, Settings.radius, 210),
            Geolib.computeDestinationPoint(center, Settings.radius, 240),
            Geolib.computeDestinationPoint(center, Settings.radius, 270),
            Geolib.computeDestinationPoint(center, Settings.radius, 300),
            Geolib.computeDestinationPoint(center, Settings.radius, 330)
        ];
    };

    // calculate bearing
    self.calculateBearing = function (start, end) {
        // where φ1,λ1 is the start point, φ2,λ2 the end point (Δλ is the difference in longitude)
        var y = Math.sin(end.longitude - start.longitude) * Math.cos(end.latitude);
        var x = Math.cos(start.latitude) * Math.sin(end.latitude) - Math.sin(start.latitude) * Math.cos(end.latitude) * Math.cos(end.longitude - start.longitude);
        return Math.atan2(y, x).toDegrees();
    }
    // generate random location within radius
    self.getRandomLocation = function(latitude, longitude, radius) {
        // Convert radius from meters to degrees
        var radiusInDegrees = radius / 111000.0;

        var u = Math.random();
        var v = Math.random();
        var w = radiusInDegrees * Math.sqrt(u);
        var t = 2 * Math.PI * v;
        var x = w * Math.cos(t);
        var y = w * Math.sin(t);

        // Adjust the x-coordinate for the shrinking of the east-west distances
        var new_x = x / Math.cos(latitude);

        var foundLongitude = new_x + longitude;
        var foundLatitude = y + latitude;
        return { latitude: foundLatitude, longitude: foundLongitude };
    }

    // get player, hatched eggs, and inventory data
    self.getTrainerInformation = function () {
        return new Promise(function(resolve, reject) {
            // get player profile and inventory in batch mode
            self.client.batchStart().getPlayer().getHatchedEggs().getInventory(0).batchCall().then(responses => {
                // responses is: [GetPlayerResponse, GetHatchedEggsResponse, GetInventoryResponse]
                // parse player data
                let team = ['Nuetral', 'Mystic', 'Valor', 'Instinct'];
                let profile = responses[0].player_data;
                self.character.username = profile.username;
                self.character.team = team[profile.team];
                self.character.pokeStorage = profile.max_pokemon_storage;
                self.character.itemStorage = profile.max_item_storage;
                self.character.pokeCoin = profile.currencies[0].amount;
                self.character.stardust = profile.currencies[1].amount;
                self.character.location.latitude = self.client.playerLatitude;
                self.character.location.longitude =self.client.playerLongitude;

                // parse hatched egg data
                let hatched = responses[1];
                let hatchedInfo = [];
                if (hatched.candy_awarded.length > 0) {
                    for (let i = 0; i < hatched.candy_awarded.length; i++) {
                        hatchedInfo.push({
                            candy: hatched.candy_awarded[i],
                            experience: hatched.experience_awarded[i],
                            pokemon: PokemonList[hatched.pokemon_id[i] - 1],
                            stardust: hatched.stardust_awarded[i]
                        });
                    }
                }

                //parse inventories
                let inventories = responses[2].inventory_delta.inventory_items;
                let itemCount = 0;
                self.character.pokemons.length = 0;
                self.character.eggs.length = 0;
                self.character.items.length = 0;
                self.character.candies.length = 0;
                inventories.forEach(inventory => {
                    let data = inventory.inventory_item_data;
                    if (data.player_stats) {
                        self.character.level = data.player_stats.level;
                        self.character.experience = data.player_stats.experience.low;
                        self.character.nextExperience = data.player_stats.next_level_xp.low;
                        self.character.kmWalked = data.player_stats.km_walked;
                    }
                    if (data.pokemon_data) {
                        if (data.pokemon_data.is_egg) {
                            self.character.eggs.push(data.pokemon_data);
                        }
                        else {
                            data.pokemon_data.data = PokemonList[data.pokemon_data.pokemon_id - 1];
                            data.pokemon_data.defending = data.pokemon_data.deployed_fort_id != '' ? 'defending' : '';
                            self.character.pokemons.push(data.pokemon_data);
                        }
                    }
                    if (data.item) {
                        data.item.name = ItemList[data.item.item_id];
                        data.item.count = data.item.count != null ? data.item.count : 0; 
                        self.character.items.push(data.item);
                        itemCount = itemCount + data.item.count;
                    }
                    if (data.candy) {
                        self.character.candies.push({ familyId: data.candy.family_id, candy: data.candy.candy });
                    }
                });
                self.character.totalItems = itemCount;
                self.character.pokemons.sort((a, b) => {
                    return a.pokemon_id - b.pokemon_id || b.cp - a.cp;
                });
                self.character.items.sort((a, b) => {
                    return a.item_id - b.item_id;
                });

                if (self.io) {
                    self.io.emit('character', { character: self.character, hatchedInfo: hatchedInfo });
                }

                // log player info
                self.logger.info('[o] -> Player: ' + self.character.username);
                self.logger.info('[o] -> Level: ' + self.character.level);
                self.logger.info('[o] -> Team: ' + self.character.team);
                self.logger.info('[o] -> Exp: ' + numberWithCommas(self.character.experience) + '/' + numberWithCommas(self.character.nextExperience));
                self.logger.info('[o] -> Poke Coin: ' + self.character.pokeCoin);
                self.logger.info('[o] -> Stardust: ' + self.character.stardust);
                self.logger.info('[o] -> Pokemons: ' + self.character.pokemons.length + '/' + self.character.pokeStorage);
                self.logger.info('[o] -> Items: ' + self.character.totalItems + '/' + self.character.itemStorage);
                self.logger.info('[o] -> location lat:' + self.character.location.latitude + ' lng: ' + self.character.location.longitude);

                hatchedInfo.forEach(element => {
                    self.logger.info('[o] -> Hatched: ' + element.stardust);
                });

                if (self.initialCleanup) {
                    self.initialCleanup = false;
                    self.cleaningPokemon();
                    // schedule auto-clean every 30 minutes
                    setInterval(() => {
                        self.cleaningPokemon();
                    }, 1800000);
                }
                resolve();
            }).catch(err => {
                self.logger.error(err);
                reject(err);
            });
        });
    }

    // character data formater
    self.cleaningPokemon = function () {
        if (Settings.autoCleanPokemon) {
            self.started = false;
            if (self.io) {
                self.io.emit('cleaningPokemon');
            }
            self.logger.info('[t] Transfering overcaptured pokemons...');
            var groupedPokemons = [];
            // grouping pokemons
            self.character.pokemons.forEach((pokemon) => {
                var pm = groupedPokemons.find((element) => {
                    return element.pokemonId == pokemon.data.id;
                });
                if (typeof(pm) == 'undefined') {
                    groupedPokemons.push({ pokemonId: pokemon.data.id, pokemons: [ pokemon ] });
                }
                else {
                    pm.pokemons.push(pokemon);
                }
            });

            // sorting and filtering removal
            groupedPokemons.forEach((group) => {
                var keepNumber = Settings.pokemonKeepNumber;
                var keepLimit = self.transferSpecific.find(keep => {
                    return keep.pokemonId == group.pokemonId;
                });
                if (typeof(keepLimit) != 'undefined') {
                    keepNumber = keepLimit.limit;
                }
                if (group.pokemons.length > keepNumber) {
                    group.pokemons.sort((a, b) => {
                        return b.cp - a.cp;
                    });
                    self.transferingPokemons.push.apply(self.transferingPokemons, group.pokemons.slice(keepNumber));                                            
                }
            });

            if (self.transferingPokemons.length > 0) {
                var cleanupLoop = setInterval(function() {
                    return new Promise(function(resolve, reject) {
                        if (self.transferingPokemons.length > 0) {
                            self.client.releasePokemon(self.transferingPokemons[0].id).then(response => {
                                if (response.result == 1) {
                                    self.logger.info('[t] Successfully transfering ' + self.transferingPokemons[0].data.name + '(CP: ' + self.transferingPokemons[0].cp + ')!');
                                    self.transferingPokemons.splice(0, 1);
                                }
                                if (self.transferingPokemons.length == 0) {
                                    self.logger.info('[t] Transfering finished!');
                                    clearInterval(cleanupLoop);
                                    self.started = true;
                                    self.getTrainerInformation().then(() => {
                                        if (self.io) {
                                            self.io.emit('pokemonCleaned');
                                        }
                                        resolve();
                                    }).catch((err) => {
                                        console.log(err);
                                        reject(err);
                                    });
                                }
                                else {
                                    resolve();
                                }
                            }).catch((err) => {
                                console.log(err);
                            });
                        }
                        else {
                            clearInterval(cleanupLoop);
                            self.started = true;
                            if (self.io) {
                                self.io.emit('pokemonCleaned');
                            }
                            self.logger.info('[t] Transfering finished!');
                        }
                    }).then((a) => {
                        return null;
                    });
                }, 5000);
            }
            else {
                self.started = true;
                if (self.io) {
                    self.io.emit('pokemonCleaned');
                }
                self.logger.info('[t] Transfering finished!');
            }
        }
    }

    self.collectPokeStop = function (pokestop) {
        return new Promise(function(resolve, reject) {
            self.client.fortSearch(pokestop.id, pokestop.latitude, pokestop.longitude).then(response => {
                var status = ['Unexpected Error','Successful collect','Out of range','Already collected','Inventory Full'];

                // result = 1 means success
                if (response.result == 1) {
                    self.collectedPokeStops.push({ pokeStop: pokestop, timestamp: new Date() });
                    self.logger.info('[s] Collect status for PokeStop at ' + pokestop.latitude + ', ' + pokestop.longitude + " was " + status[parseInt(response.result)]);
                    response.items_awarded.forEach((item) => {
                        item.item_name = ItemList[item.item_id]; 
                        self.logger.info('[s] Get item: ' + item.item_name);
                    });
                    self.io.emit('collected', { items: response.items_awarded });
                }
                else if (response.result == 3 || response.result == 4) {
                    self.collectedPokeStops.push({ pokeStop: pokestop, timestamp: new Date() });                    
                }
                resolve({ status: parseInt(response.result), message: status[parseInt(response.result)] });
            });
            return null;
        });
    }

    self.catchPokemon = function (pokemon) {
        return new Promise(function(resolve, reject) {
            self.client.encounter(pokemon.encounter_id, pokemon.spawn_point_id).then(eResponse => {
                // if eResponse is 'No result', this means we get nothing from the server
                if (eResponse == 'No result') {
                    reject(new Error(eResponse));
                }
                // else, encounter successful. time to throwing balls... :3
                else {
                    self.logger.info('[e] Encounter ' + pokemon.data.name + '...');
                    setTimeout(() => {
                        var ball = Settings.ball;
                        for (let i = ball; i < 5; i++) {
                            var item = self.character.items.find(element => {
                                return element.item_id == i
                            });
                            if (typeof(item) == 'undefined') {
                                ball = 5;
                                break;
                            }
                            else if (item.count <= 0) {
                                ball = ball + 1;
                            }
                            else {
                                break;
                            }
                        }
                        if (ball < 5 && eResponse.wild_pokemon) {
                            self.client.catchPokemon(eResponse.wild_pokemon.encounter_id, ball, 1.950, eResponse.wild_pokemon.spawn_point_id, true, 1, 1).then(cResponse => {
                                // if cResponse is 'No result', this means we get nothing from the server
                                if (cResponse == 'No result') {
                                    reject(new Error(cResponse));
                                }
                                // else, catch request successful. parse the result
                                var status = ['Unexpected error', 'Successful catch', 'Catch Escape', 'Catch Flee', 'Missed Catch'];
                                if(cResponse.status == null) {
                                    self.logger.info('[c] Error: You have no more of that ball left to use!');
                                } else {
                                    eResponse.wild_pokemon.data = PokemonList[eResponse.wild_pokemon.pokemon_data.pokemon_id - 1];
                                    self.logger.info('[c] Catch status for ' + eResponse.wild_pokemon.data.name + ': ' + status[parseInt(cResponse.status)]);
                                    if (cResponse.status == 1) {
                                        var pm = self.character.captives.find((pm) => {
                                            return pm.data.id == eResponse.wild_pokemon.data.id;
                                        });
                                        if (typeof(pm) == 'undefined') {
                                            eResponse.wild_pokemon.count = 1;
                                            self.character.captives.push(eResponse.wild_pokemon);
                                        }
                                        else {
                                            pm.count = pm.count + 1;
                                        }
                                        self.logger.info('[s] Captured ' + eResponse.wild_pokemon.data.name + ' at ' + eResponse.wild_pokemon.latitude + ', ' + eResponse.wild_pokemon.longitude + ', at ' + dateFormat(new Date(), "yyyy-mm-dd h-MM-ss"));
                                        self.io.emit('captured', { pokemon: eResponse.wild_pokemon });
                                    }
                                }
                                resolve({ status: parseInt(cResponse.Status), message: status[parseInt(cResponse.Status)] });
                            });
                            return null;
                        }
                        else {
                            resolve();
                        }
                    }, 3000);
                }
                return null;
            });
            return null;
        });
    }

    self.moveCharacter = function () {
        if (Settings.movement == "random") {
            // if we don't have any destination, create one..
            if (!self.destination) {
                self.destination = self.getRandomLocation(Settings.centerLatitude, Settings.centerLongitude, Settings.radius);
            }

            if (self.io) {
                self.io.emit('destination', { destination: self.destination });
            }

            // move to our destination bit by bit. calculate bearing and new step coordinate
            var bearing = self.calculateBearing(self.character.location, self.destination);
            var nextStep = Geolib.computeDestinationPoint(self.character.location, Settings.step, bearing);

            // if the distance between next step and destination is less than step, remove destination
            if (Geolib.getDistance(self.destination, nextStep) <= Settings.step) {
                self.destination = null;
                if (self.io) {
                    self.io.emit('destination', { destination: self.destination });
                }
            }

            // step the character
            var location = {
                type: 'coords',
                coords: {
                    latitude: nextStep.latitude,
                    longitude: nextStep.longitude,
                    altitude: 0
                }
            };
            self.client.setPosition(location.coords.latitude, location.coords.longitude);
            self.character.location = location.coords;
            self.logger.info('[m] Move to ' + location.coords.latitude + ', ' + location.coords.longitude);
        }
    }

    self.heartbeat = function () {
        return new Promise(function(resolve, reject) {
            if(self.started && self.doLoop) {
                // init heartbeat object
                self.hbData = {
                    location: self.character.location,
                    pokeStops: [],
                    gyms: [],
                    catchablePokemons: [],
                    nearbyPokemons: [],
                    wildPokemons: []
                };
                var cellIDs = pogobuf.Utils.getCellIDs(self.client.playerLatitude, self.client.playerLongitude);
                // var cellIDs = utils.getCellIDs(self.client.playerLatitude, self.client.playerLongitude);
                self.logger.info('[o] ------------');
                self.logger.info('[o] Get heartbeat...');
                return Promise.resolve(self.client.getMapObjects(cellIDs, Array(cellIDs.length).fill(0))).then(mapObjects => {
                    self.logger.info('[o] parsing...');
                    return mapObjects.map_cells;
                }).each(cell => {
                    // parse forts
                    Promise.resolve(cell.forts).each(fort => {
                        if (fort.type == 1) {
                            var ps = self.collectedPokeStops.find((ps) => {
                                return ps.pokeStop.id == fort.id;
                            });
                            if (typeof(ps) != 'undefined') {
                                fort.enabled = false;
                            }
                            self.hbData.pokeStops.push(fort);
                        }
                        else {
                            self.hbData.gyms.push(fort);
                        }
                        return null;
                    });
                
                    // parse catchable pokemons
                    Promise.resolve(cell.catchable_pokemons).each(pokemon => {
                        pokemon.data = PokemonList[parseInt(pokemon.pokemon_id) - 1];
                        self.hbData.catchablePokemons.push(pokemon);
                        return null;
                    });

                    // parse nearby pokemons
                    Promise.resolve(cell.nearby_pokemons).each(pokemon => {
                        pokemon.data = PokemonList[parseInt(pokemon.pokemon_id) - 1];
                        self.hbData.nearbyPokemons.push(pokemon);
                        return null;
                    });

                    // parse wild pokemons
                    Promise.resolve(cell.wild_pokemons).each(pokemon => {
                        pokemon.data = PokemonList[parseInt(pokemon.pokemon_data.pokemon_id) - 1];
                        self.hbData.wildPokemons.push(pokemon);
                        return null;
                    });

                    return null;
                }).then(() => {
                    if (self.io) {
                        // post heartbeat event
                        self.io.emit('heartbeat', { heartbeat: self.hbData });
                    }
                    //utils.test();
                    self.logger.info('[o] processing...');

                    // process nearby, collectable pokeStops
                    if (Settings.collect && self.doLoop && self.character.totalItems < self.character.itemStorage) {
                        self.doLoop = false;
                        var found = false;
                        for (let i = 0; i < self.hbData.pokeStops.length; i++) {
                            var pokeStop = self.hbData.pokeStops[i];
                            // if enabled
                            if (pokeStop.enabled) {
                                // and close enough to collect
                                var distance = Geolib.getDistance(self.character.location, {
                                    latitude: pokeStop.latitude,
                                    longitude: pokeStop.longitude
                                });
                                if (distance <= 40) {
                                    found = true;
                                    // collect item from this pokestop
                                    self.collectPokeStop(pokeStop).finally(() => {
                                        self.doLoop = true;
                                    });
                                    break;
                                }
                            }
                        }
                        // no collectable pokestops. continue the loop
                        if (!found) {
                            self.doLoop = true;
                        }
                    }

                    // process wild pokemons
                    self.hbData.catchablePokemons.forEach(pokemon => {
                        self.logger.info('[+] There is a catchable ' + pokemon.data.name + ' -  ' + parseInt(pokemon.expiration_timestamp_ms) / 1000 + ' seconds until hidden.');
                    });

                    // catching the first wild pokemon available
                    if (Settings.encounter && self.doLoop) {
                        self.doLoop = false;
                        if (self.hbData.catchablePokemons.length > 0) {
                            var shouldCatch = false;

                            if (Settings.target == "all") {
                                shouldCatch = true;
                            }
                            else if (Settings.target == "except") {
                                for (let i = self.hbData.catchablePokemons.length - 1; i >= 0; i--) {
                                    var pokemon = self.hbData.catchablePokemons[i];
                                    var target = self.specificTargets.find((element) => {
                                        return element.id == pokemon.data.id;
                                    });
                                    if (typeof(target) != 'undefined') {
                                        self.hbData.catchablePokemons.splice(i, 1);
                                    }
                                }
                            }
                            else if (Settings.target == "only") {
                                for (let i = self.hbData.catchablePokemons.length - 1; i >= 0; i--) {
                                    var pokemon = self.hbData.catchablePokemons[i];
                                    var target = self.specificTargets.find((element) => {
                                        return element.id == pokemon.data.id;
                                    });
                                    if (typeof(target) == 'undefined') {
                                        self.hbData.catchablePokemons.splice(i, 1);
                                    }
                                }
                            }

                            self.catchPokemon(self.hbData.catchablePokemons[0]).then(result => {
                                return self.getTrainerInformation().then(() => {
                                    self.doLoop = true;
                                });
                            }).catch((err) => {
                                self.doLoop = true;
                            });
                        }
                        else {
                            self.doLoop = true;
                        }
                    }

                    // move the character
                    if (self.doLoop) {
                        self.moveCharacter();
                    }

                    self.logger.info('[o] Heartbeat done.');
                    // resolve();
                }).catch(err => {
                    self.logger.error(err);
                });
            }
            else {
                resolve();
            }
        });
    }

    // start the bot
    self.start = function () {
        self.started = true;
        self.logger.info('[o] -> Started!');

        // only accept ptc or google
        if (Settings.provider !== 'ptc' && Settings.provider !== 'google') {
            self.logger.error('[x] -> Invalid provider! Exiting...');
            return new Error('Invalid provider');
        }

        // get respective login
        if (Settings.provider == 'ptc') {
            self.login = new pogobuf.PTCLogin();
        }
        else {
            self.login = new pogobuf.GoogleLogin();
        }

        // do login
        self.client = new pogobuf.Client();
        self.login.login(Settings.username, Settings.password)
        .then(token => {
            if (Settings.provider == 'ptc') {
                self.client.setAuthInfo('ptc', token);
            }
            else {
                self.client.setAuthInfo('google', token);
            }
            self.client.setPosition(Settings.centerLatitude, Settings.centerLongitude);
            self.character.location = { latitude: Settings.centerLatitude, longitude: Settings.centerLongitude };
            return self.client.init();
        }).then(() => {
            return self.getTrainerInformation();
        }).then(() => {
            // initial trainer data was obtained. now start the loop
            self.doLoop = true;
            var loopInterval = setInterval(function() {
                self.heartbeat();
            }, Settings.loopInterval);
            return null;
        });
    }
}

module.exports = new PokeGoWorker();
