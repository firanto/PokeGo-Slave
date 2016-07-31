var Promise = require("bluebird");
var Geolib = require('geolib');
var dateFormat = require('dateformat');
var log4js = require('log4js');
var fs = require('fs');

var Pokeio = Promise.promisifyAll(require('pokemon-go-node-api'));

// load settings data
const PokemonList = JSON.parse(fs.readFileSync(__dirname + '/pokemons.json', 'utf8')).pokemon;
const ItemList = JSON.parse(fs.readFileSync(__dirname + '/items.json', 'utf8'));

var Settings = JSON.parse(fs.readFileSync(__dirname + '/settings.json', 'utf8'));

log4js.configure({ appenders: [ { type: 'console' }, { type: 'file', filename: 'logs/log ' + dateFormat(new Date(), "yyyy-mm-dd h-MM-ss") + '.log', category: 'PokeGoSlave' } ]});
log4js.configure({ appenders: [ { type: 'console' }, { type: 'file', filename: 'logs/captured pokemons ' + dateFormat(new Date(), "yyyy-mm-dd h-MM-ss") + '.log', category: 'PokeGoCaptured' } ]});

// Extend Number object with method to convert radians to numeric (signed) degrees 
if (Number.prototype.toDegrees === undefined) {
    Number.prototype.toDegrees = function() { return this * 180 / Math.PI; };
}

var PokeGoWorker = function () {
    var self = this;
    self.logger = log4js.getLogger('PokeGoSlave');
    self.captiveLog = log4js.getLogger('PokeGoCaptured');

    // socket.io object
    self.io = null;

    // run and loop state
    self.started = false;
    self.doLoop = false;

    // character data
    self.character = {
        username: '',
        team: '',
        pokeStorage: 0,
        itemStorage: 0,
        pokeCoin: 0,
        stardust: 0,
        location: {
            name: '',
            latitude: Settings.centerLatitude,
            longitude: Settings.centerLongitude,
            altitude: Settings.centerAltitude
        },
        pokemons: [],
        items: [],
        captives: []
    }

    self.destination = null;
    self.collectedPokeStops = [];

    self.specificTargets = [];
    Settings.specificTargets.forEach((target) => {
        var pokemon = PokemonList.find((pokemon) => {
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

    // character data formater
    self.formatPlayerCard = function(profile) {
        let team = ['Nuetral','Mystic','Valor','Instinct'];

        if (profile.team == null) {
            profile.team = 0;
        }
        if (!profile.currency[0].amount) {
            profile.currency[0].amount = 0;
        }

        self.character.username = profile.username;
        self.character.team = team[profile.team];
        self.character.pokeStorage = profile.poke_storage;
        self.character.itemStorage = profile.item_storage;
        self.character.pokeCoin = profile.currency[0].amount;
        self.character.stardust = profile.currency[1].amount;
        self.character.location.name = Pokeio.playerInfo.locationName;
        self.character.location.latitude = Pokeio.playerInfo.latitude;
        self.character.location.longitude = Pokeio.playerInfo.longitude;
        self.character.location.altitude = Pokeio.playerInfo.altitude;

        if (self.io) {
            self.io.emit('character', { character: self.character });
        }

        self.logger.info('[o] -> Player: ' + profile.username);
        self.logger.info('[o] -> Team: ' + team[profile.team]);
        self.logger.info('[o] -> Poke Storage: ' + profile.poke_storage);
        self.logger.info('[o] -> Item Storage: ' + profile.item_storage);
        self.logger.info('[o] -> Poke Coin: ' + profile.currency[0].amount);
        self.logger.info('[o] -> Star Dust: ' + profile.currency[1].amount);
        self.logger.info('[o] -> location lat:' + Pokeio.playerInfo.latitude + ' lng: ' + Pokeio.playerInfo.longitude);
        return true;
    };

    self.collectPokeStop = function (pokestop) {
        return new Promise(function(resolve, reject) {
            Pokeio.GetFortAsync(pokestop.FortId, pokestop.Latitude, pokestop.Longitude).then((gfResponse) => {
                var status = ['Unexpected Error','Successful collect','Out of range','Already collected','Inventory Full'];
                // result = 1 means success
                if (gfResponse.result == 1) {
                    self.collectedPokeStops.push({ pokeStop: pokestop, timestamp: new Date() });
                    self.logger.info('[s] Collect status for PokeStop at ' + pokestop.Latitude + ', ' + pokestop.Longitude + " was " + status[parseInt(gfResponse.result)]);
                    gfResponse.items_awarded.forEach((item) => {
                        item.item_name = ItemList[item.item_id]; 
                        self.logger.info('[s] Get item: ' + item.item_id);
                    });
                    self.io.emit('collected', { items: gfResponse.items_awarded });
                }
            }).catch((err) => {
                reject(err);
            });
        });
    }

    self.catchPokemon = function (pokemon) {
        return new Promise(function(resolve, reject) {
            Pokeio.EncounterPokemonAsync(pokemon).then((data) => {
                // if data is 'No result', this means we get nothing from the server
                if (data == 'No result') {
                    reject(new Error(data));
                }
                // else, encounter successful. time to throwing balls... :3
                else {
                    Pokeio.CatchPokemonAsync(data.WildPokemon, 1, 1.950, 1, Settings.ball).then((final) => {
                        // if data is 'No result', this means we get nothing from the server
                        if (data == 'No result') {
                            reject(new Error(data));
                        }
                        // else, catch request successful. parse the result
                        var status = ['Unexpected error', 'Successful catch', 'Catch Escape', 'Catch Flee', 'Missed Catch'];
                        if(final.Status == null) {
                            self.logger.info('[x] Error: You have no more of that ball left to use!');
                        } else {
                            data.WildPokemon.data = PokemonList[data.WildPokemon.pokemon.PokemonId - 1];
                            self.logger.info('[s] Catch status for ' + data.WildPokemon.data.name + ': ' + status[parseInt(final.Status)]);
                            if (final.Status == 1) {
                                var pm = self.character.captives.find((pm) => {
                                    return pm.data.id == data.WildPokemon.data.id;
                                });
                                if (typeof(pm) == 'undefined') {
                                    data.WildPokemon.count = 1;
                                    self.character.captives.push(data.WildPokemon);
                                }
                                else {
                                    pm.count = pm.count + 1;
                                }
                                self.captiveLog.info('Captured ' + data.WildPokemon.data.name + ' at ' + data.WildPokemon.Latitude + ', ' + data.WildPokemon.Longitude + ', at ' + dateFormat(new Date(), "yyyy-mm-dd h-MM-ss"));
                                self.io.emit('captured', { pokemon: data.WildPokemon });
                            }
                        }
                        resolve({ status: parseInt(final.Status), message: status[parseInt(final.Status)] });
                    }).catch((err) => {
                        reject(err);
                    });
                }
            }).catch((err) => {
                reject(err);
            });
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
            Pokeio.SetLocationAsync(location).then((finalStep) => {
                self.character.location = finalStep;
            });
        }
    }

    // start the bot
    self.start = function () {
        self.started = true;
        self.logger.info('[o] -> Started!');

        // build initial location data
        var location = {
            type: Settings.centerType,
            name: Settings.centerName,
            coords: {
                latitude: Settings.centerLatitude,
                longitude: Settings.centerLongitude,
                altitude: Settings.centerAltitude
            }
        };

        // init client login
        Pokeio.initAsync(Settings.username, Settings.password, location, Settings.provider).then(() => {
            // get profile
            Pokeio.GetProfileAsync().then((profile) => {
                // set character data
                self.formatPlayerCard(profile);

                // loop until user says stop
                self.doLoop = true;
                setInterval(function() {
                    return new Promise(function(resolve, reject) {
                        if(self.started && self.doLoop) {
                            // call heartbeat
                            Pokeio.HeartbeatAsync().then((heartbeat) => {
                                self.logger.info('[+] ------------');
                                self.logger.info('[+] Heartbeat:');
                                
                                // init object
                                var hbData = {
                                    location: self.character.location,
                                    pokeStops: [],
                                    gyms: [],
                                    mapPokemons: [],
                                    nearbyPokemons: [],
                                    wildPokemons: []
                                };

                                //remove all stored pokestops older than 5 minutes
                                var currentTimestamp = new Date();
                                for (i = self.collectedPokeStops.length - 1; i >= 0; i--) {
                                    var storedStop = self.collectedPokeStops[i];
                                    if (Math.floor((Math.abs(currentTimestamp - storedStop.timestamp)/1000)/60) > 5) {
                                        self.collectedPokeStops.splice(i, 1);
                                    }
                                }

                                // loop to get the values
                                heartbeat.cells.forEach(function(cell) {
                                    // parse forts
                                    if (cell.Fort.length > 0) {
                                        cell.Fort.forEach(function(fort) {
                                            if (fort.FortType == 1) {
                                                var ps = self.collectedPokeStops.find((ps) => {
                                                    return ps.pokeStop.FortId == fort.FortId;
                                                });
                                                if (typeof(ps) != 'undefined') {
                                                    fort.Enabled = false;
                                                }
                                                hbData.pokeStops.push(fort);
                                            }
                                            else {
                                                hbData.gyms.push(fort);
                                            }
                                        });
                                    }

                                    // parse map pokemons
                                    if (cell.MapPokemon.length > 0) {
                                        cell.MapPokemon.forEach(function(pokemon) {
                                            pokemon.data = PokemonList[parseInt(pokemon.PokedexTypeId) - 1];
                                            hbData.mapPokemons.push(pokemon);
                                        });
                                    }

                                    // parse nearby pokemons
                                    if (cell.NearbyPokemon.length > 0) {
                                        cell.NearbyPokemon.forEach((pokemon) => {
                                            pokemon.data = PokemonList[parseInt(pokemon.PokedexNumber) - 1];
                                            hbData.nearbyPokemons.push(pokemon);
                                        });
                                    }

                                    // parse wild pokemons
                                    if (cell.WildPokemon.length > 0) {
                                        cell.WildPokemon.forEach((pokemon) => {
                                            pokemon.data = PokemonList[parseInt(pokemon.pokemon.PokemonId) - 1];
                                            hbData.wildPokemons.push(pokemon);
                                        });
                                    }
                                });

                                // post heartbeat event
                                self.io.emit('heartbeat', { heartbeat: hbData });

                                // process nearby, collectable pokeStops
                                if (Settings.collect) {
                                    self.doLoop = false;
                                    var found = false;
                                    for (i = 0; i < hbData.pokeStops.length; i++) {
                                        var pokeStop = hbData.pokeStops[i];
                                        // if enabled
                                        if (pokeStop.Enabled) {
                                            // and close enough to collect
                                            var distance = Geolib.getDistance(self.character.location, {
                                                latitude: pokeStop.Latitude,
                                                longitude: pokeStop.Longitude
                                            });
                                            if (distance <= 35) {
                                                found = true;
                                                // collect item from this pokestop
                                                self.collectPokeStop(pokeStop).then(() => {
                                                    self.doLoop = true;
                                                }).catch((err) => {
                                                    self.doLoop = true;
                                                });
                                                // currently there are no api available for this. so... skip it
                                                // self.doLoop = true;
                                                break;
                                            }
                                        }
                                    }
                                    // no collectable pokestops. continue the loop
                                    if (!found) {
                                        self.doLoop = true;
                                    }
                                }

                                // process nearby pokemons
                                hbData.nearbyPokemons.forEach((pokemon) => {
                                    self.logger.info('[+] There is a nearby ' + pokemon.data.name + ' at approximate ' + parseInt(pokemon.DistanceMeters) + ' meters.');
                                });

                                // process map pokemons - well... we don't. It seems that every map pokemons are also exist on wild pokemons
                                // hbData.mapPokemons.forEach((pokemon) => {
                                //     self.logger.info('[+] There is a catchable ' + pokemon.data.name + ' - lured by lure module.');
                                // });

                                // process wild pokemons
                                hbData.wildPokemons.forEach((pokemon) => {
                                    self.logger.info('[+] There is a catchable ' + pokemon.data.name + ' -  ' + parseInt(pokemon.TimeTillHiddenMs) / 1000 + ' seconds until hidden.');
                                });

                                // catching the first wild pokemon available
                                if (Settings.encounter) {
                                    self.doLoop = false;
                                    if (hbData.wildPokemons.length > 0) {
                                        var shouldCatch = false;

                                        if (Settings.target == "all") {
                                            shouldCatch = true;
                                        }
                                        else if (Settings.target == "except") {
                                            hbData.wildPokemons.forEach((pokemon) => {
                                                var target = self.specificTargets.find((element) => {
                                                    return element.id == pokemon.data.id;
                                                });
                                            });
                                        }
                                        else if (Settings.target == "only") {
                                            hbData.wildPokemons.forEach((pokemon) => {
                                                var target = self.specificTargets.find((element) => {
                                                    return element.id == pokemon.data.id;
                                                });
                                            });
                                        }

                                        self.catchPokemon(hbData.wildPokemons[0]).then((data) => {
                                            Pokeio.GetProfileAsync().then((profile) => {
                                                // set character data
                                                self.formatPlayerCard(profile);
                                                self.doLoop = true;
                                            }).catch((err) => {
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
                                if (self.doLoop)
                                    self.moveCharacter();
                            }).catch((err) => {
                                self.doLoop = true;
                                resolve(err);
                            });
                        } else {
                            resolve('[p] Looping stalled to complete execution of task..');
                        }
                    }).then((a) => {self.logger.info(a);});
                }, Settings.loopInterval);
            })
            .catch((err) => {
                self.doLoop = true;
            });
        })
        .catch((err) => {
            self.doLoop = true;
        });
    }
}

module.exports = new PokeGoWorker();