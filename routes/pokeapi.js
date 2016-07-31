var express = require('express');
var router = express.Router();

var Pokeio = require('pokemon-go-node-api');

router.use(function (req, res, next) {
    var sessionToken = req.session.token;
        if (req.headers['access-token'] == req.session.token) {
        next();
    }
    else {
        res.status(401).json({ error: 'Unauthorized request' });
    }
})

// no root access allowed
router.get('/', function (req, res, next) {
    res.status(404).json({ error: 'Invalid request' });
});

// authenticate user and scan it's surrounding once
router.post('/scan', function (req, res, next) {
    var username = req.body.username;
    var password = req.body.password;
    var latitude = req.body.latitude;
    var longitude = req.body.longitude;

    var location = { type: "coords", coords: { latitude: latitude, longitude: longitude, altitude: 1 } };
    var character = null;

    try {
        Pokeio.init(username, password, location, "ptc", function(err) {
            if (err) throw err;

            try {
                Pokeio.GetProfile(function(err, profile) {
                    if (err) throw err;

                    var poke = 0;
                    if (profile.currency[0].amount) {
                        poke = profile.currency[0].amount;
                    }

                    try {
                        Pokeio.Heartbeat(function(err, heartbeat) {
                            if(err) {
                                console.log(err);
                            }

                            character = {
                                username: profile.username,
                                pokeStorage: profile.poke_storage,
                                itemStorage: profile.item_storage,
                                pokeCoin: poke,
                                stardust: profile.currency[1].amount,
                                location: {
                                    locationName: Pokeio.playerInfo.locationName,
                                    latitude: Pokeio.playerInfo.latitude,
                                    longitude: Pokeio.playerInfo.longitude,
                                    altitude: Pokeio.playerInfo.altitude
                                },
                                heartbeat: heartbeat
                            }

                            res.status(200).json({ error: null, character: character });
                        });
                    } catch (error) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                });
            } catch (error) {
                res.status(500).json({ error: 'Internal Server Error' });
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
