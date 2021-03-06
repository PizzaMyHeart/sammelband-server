const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
let RedisStore = require("connect-redis")(session);
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const puppeteer = require('puppeteer');
const processUrls = require('./components/process-urls');
const fetchFromURL = require('./components/fetch-from-url');
const parseDocuments = require('./components/parse-documents');
const convertFromHtml = require('./components/convert-from-html');
const mail = require('./components/mail');
const { getPocketToken, getPocketList }= require('./components/pocket');
const deleteFile = require('./components/delete-file');
const { loginUser, signUpUser, verifyUser, checkUserVerified, sendToken, encodeToken } = require('./components/auth');
const jwt = require('jsonwebtoken');
const logger = require('./components/logger');



const app = express();
app.set('trust proxy', '127.0.0.1');
app.use(logger);
// Initialize a Puppeteer browser instance, reuse for subsequent requests
let browser;
(async () => {
    browser = await puppeteer.launch({
        executablePath: '/usr/bin/chromium-browser',
        args: [
            '--no-sandbox', 
            '--headless', 
            '--disable-gpu', 
            '--disable-features=site-per-process',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
        ]
    })
})();

const { createClient } = require("redis")
let redisClient = createClient({ legacyMode: true })
redisClient.connect().catch(console.error)

const rateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1-minute window
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
});

app.use(rateLimiter);

app.use(cors({
    // origin needs to be set explicitly to allow fetch() calls from the front-end
    // to include cookies in the request (credentials: include)
    origin: [process.env.CLIENT_URL, /localhost/], // passing array as environment variable here doesn't work
    credentials: true
}));

app.use(
    session({
      store: new RedisStore({ client: redisClient }),
      saveUninitialized: false,
      secret: process.env.SESSION_SECRET,
      resave: false,
    })
  )

app.use(express.json());





// TODO: Create /public folder if does not exist
app.use('/public', express.static(path.join(__dirname, 'public')));
const port = process.env.PORT || 3001; // for Heroku deployment

const styles = require('./styles'); // Load CSS styles from ./styles.js
const { resourceLimits } = require('worker_threads');
const { JsonWebTokenError } = require('jsonwebtoken');
const { get } = require('http');



function applyStyle(color, font) {
    //console.log(`Style: ${font}`);
    //console.log(`Color: ${color}`);
    return styles.head + 
            styles.base + 
            ((font=='sansSerif') ? styles.sansSerif : styles.serif) + 
            ((color=='dark') ? styles.dark : styles.light) +
            styles.tail;
}

function writeToFile(parsedArticles, req) {
    console.log('writeToFile');
    let id = req.session.id;
    let filepath = `./public/sammelband-${id}.html`;
    console.log(`${id}\n${filepath}`);
    // Add styles to top of html file
    //console.log(req.body.color);
    fs.writeFile(filepath, '', { flag: 'w+' }, err => {if (err) console.log(err)});
    fs.writeFile(filepath, applyStyle(req.body.color, req.body.font), { flag: 'a+' }, err => {if (err) throw err;});
 
    for (let key of Object.keys(parsedArticles)) {
        // "break-before" is a Gutenberg CSS class that places the element on a new page
        // We don't want the first article to be broken onto a new page
        // https://github.com/BafS/Gutenberg#force-break-page
        let breakBefore;
        Object.keys(parsedArticles).indexOf(key) === 0 ? breakBefore = '' : breakBefore = 'break-before';
        let author; let siteName;
        parsedArticles[key].byline ? author = `by ${parsedArticles[key].byline}` : author = '';
        parsedArticles[key].siteName ? siteName = `, ${parsedArticles[key].siteName}` : siteName = '';
        let content = `<h1 class="${breakBefore}">${parsedArticles[key].title}</h1><br/>
                        <p><i>${author}${siteName}</i></p><br/>
                        <p><a href=${key} target="_blank" rel="noreferrer">View original article</a></p>
                        ${parsedArticles[key].content}<hr/>`;
        fs.writeFile(filepath, content, { flag: 'a+' }, err => {if (err) console.log(err)});
    }

    return Object.values(parsedArticles);
    
}


function download(res, id, format) {
    console.log('download()', format);
    const filepath = path.join(__dirname, `public/sammelband-${id}.${format}`);
    console.log(`${filepath}`)
    res.download(filepath, `sammelband.${format}`, err => {
        if (err) console.log(err);
        else console.log(`sammelband.${format} downloaded.`);
    });
    
}

function handleSubmit (req, res) {
    // Executes when request is made to /api/submit
    req.session.body = req.body;
    console.log(req.session.id);

    (async () => {
        const [urls, badUrls] = processUrls(req.body.urls);
        await fetchFromURL(urls)
        .catch(err => {
            console.log(err);
            throw err;
        })
        .then(documents => parseDocuments(documents))
        .then(parsedArticles => writeToFile(parsedArticles, req))
        .then((parsedArticles) => convertFromHtml(req.body.format, req.session.id, parsedArticles, browser))
        .then((fileReady) => {
            if (fileReady) {
                console.log('File ready');
                let body = {malformedUrl: null, ready: true};
                if (badUrls.length > 0) body.malformedUrl = badUrls;
                res.send(body);
            }
        })
        .catch(err => {
            console.log(err);
            res.status(500).send(err);
        });
    })();
    
}



app.get('/api', async (req, res) => {
    console.log('Session ID: ', req.session.id);
    req.session.body = ''; // Initialize the body property of the session object
    console.log(req.session);
    let response = {};
    // Set Pocket logged in state for front-end
    req.session.pocketAccessToken ? response.pocketLoggedIn = true : response.pocketLoggedIn = false;
    req.session.loggedIn ? response.loggedIn = true : response.loggedIn = false;
    //req.session.loggedInAs = req.session.email;
    if (req.session.loggedIn) response.loggedInAs = req.session.email;
    await checkUserVerified(req.session.email)
    .then(verified => {
        response.verified = verified;
    });
    //if (!response.verified) req.session.email = '';
    req.session.email ? response.email = req.session.email : response.email = '';
    
 
    
    console.log(response);
    res.json(response);
});

app.post('/api/pocket/request', async (req, res) => {
    console.log('Session ID: ', req.session.id);
    try {
        let response = await getPocketToken('request');
        console.log('req token: ', response.data.code);
        req.session.pocketRequestToken = response.data.code; // Save the user's Pocket request token
        res.json({requestToken: response.data.code});
    }

    catch (err) {
        console.log(err);
    }
});



app.get('/api/pocket/callback', async (req, res) => {
    console.log('callback page');
    console.log('Session ID: ', req.session.id);
    try {
        let response = await getPocketToken('access', req.session.pocketRequestToken);
        console.log('Access token: ', response.data.access_token);
        req.session.pocketAccessToken = response.data.access_token;
        res.redirect(`${process.env.CLIENT_URL}`);
    }
    catch (err) {
        console.log(err);
    }
});
        
app.get('/api/pocket/list', async (req, res) => {
    console.log('Session ID: ', req.session.id);
    try {
        const accessToken = req.session.pocketAccessToken;
        console.log(accessToken);
        let response = await getPocketList(accessToken);
        res.send(response.data);
    }
    catch (err) {
        console.log(err);

    }
});

app.post('/api/submit', (req, res) => {
    console.log('Session ID: ', req.session.id);
    console.log(req.body);
    handleSubmit(req, res);
});

app.get('/api/download', (req, res) => {
    console.log('Session ID: ', req.session.id);
    download(res, req.session.id, req.session.body.format);
});



app.get('/api/mail', (req, res) => {
    console.log('Session ID: ', req.session.id);
    console.log(req.query);
    console.log(req.session);
    mail(req, res).catch((err) => {
        console.log(err);
        res.status(500).send(err);
    });
})





app.get('/api/delete', async (req, res) => {
    console.log('Session ID: ', req.session.id);
    await deleteFile(req.session.id);
    res.send('Sammelband deleted');
})

app.post('/api/login', (req, res) => {
    console.log(`Session ID: ${req.session.id}`);
    console.log(req.session);


    loginUser(req.body.email, req.body.password, req.session)
    .then(success => {
        console.log(success);
        if (success) res.json({loggedIn: true, email: req.session.email});
        else res.json({loggedIn: false});
    });
    
});

app.get('/api/logout', (req, res) => {
    console.log(`Session ID: ${req.session.id}`);
    console.log('Logging out');
    delete req.session.loggedIn;
    delete req.session.email;
    console.log(req.session);
    res.send('Logout successful');
})

app.post('/api/signup', (req, res) => {
    console.log(`Session ID: ${req.session.id}`);
    console.log(req.body);

    
    signUpUser(req.body.newEmail, req.body.newPassword)
    .then(success => {
        if (success) {
            req.session.email = req.body.newEmail;
            res.send('Signup successful.');
        } else res.status(400).send('Signup unsuccessful. Please try again.')
    }); 
}
);

app.get('/api/send-verification', async (req, res) => {
    console.log(req.session);
    await sendToken(encodeToken(req.session.email), req.session.email, 'verify');
    res.send('Verification email sent.');
});

app.get('/api/verify', (req, res) => {
    token = req.query.email;
    console.log(token);
    if (token) {
        try {
            jwt.verify(token, process.env.REGISTRATION_TOKEN_SECRET, (err, decoded) => {
                if (err) console.log(err);
                else {
                    const email = decoded.email;
                    console.log(email);
                    verifyUser(email);
                    req.session.loggedIn = true;
                    req.session.email = email;
                    res.redirect(process.env.CLIENT_URL);
                };
                
            })
        } catch (err) {
            console.log(err);
        }
    }
});

app.get('/api/send-reset-password', async (req, res) => {
    console.log(req.session);
    await sendToken(encodeToken(req.session.email), req.session.email, 'reset');
    res.send('Reset email sent');
});

app.get('/api/reset', (req, res) => {
    token = req.query.email;

})

app.listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
});

