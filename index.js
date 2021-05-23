const os = require("os"),
    fs = require("fs"),
    path = require("path"),
    https = require("https"),
    spawnSync = require("child_process").spawnSync

let SOURCE_NAME =  "default";

class Action {


    constructor() {
        this.projectFile = process.env.INPUT_PROJECT_FILE_PATH
        this.outputFolder = process.env.INPUT_OUTPUT_FOLDER
        this.noBuild = process.env.INPUT_NO_BUILD
        this.packageName = process.env.INPUT_PACKAGE_NAME || process.env.PACKAGE_NAME
        this.versionFile = process.env.INPUT_VERSION_FILE_PATH || process.env.VERSION_FILE_PATH || this.projectFile
        this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || process.env.VERSION_REGEX, "m")
        this.version = process.env.INPUT_VERSION_STATIC || process.env.VERSION_STATIC
        this.tagCommit = JSON.parse(process.env.INPUT_TAG_COMMIT || process.env.TAG_COMMIT)
        this.tagFormat = process.env.INPUT_TAG_FORMAT || process.env.TAG_FORMAT
        this.githubUser = process.env.INPUT_GITHUB_USER || process.env.GITHUB_ACTOR
        this.nugetKey = process.env.INPUT_NUGET_KEY || process.env.NUGET_KEY
        this.nugetSource = process.env.INPUT_NUGET_SOURCE || process.env.NUGET_SOURCE
        this.includeSymbols = JSON.parse(process.env.INPUT_INCLUDE_SYMBOLS || process.env.INCLUDE_SYMBOLS)
        this.throwOnVersionExixts = JSON.parse(process.env.INPUT_THOW_ERROR_IF_VERSION_EXISTS || process.env.THOW_ERROR_IF_VERSION_EXISTS)

        const existingSources = this._executeCommand("nuget sources list", { encoding: "utf8" });
        let addSourceCmd;
        if(existingSources.includes(this.nugetSource + "/v3/index.json") === false) {
            if (this.nugetSource.startsWith(`https://nuget.pkg.github.com/`)) {
                this.sourceType = "GPR"
                addSourceCmd = `nuget sourrces add -Source ${this.nugetSource}/index.json --name=${(SOURCE_NAME)} --username=${this.githubUser} --password=${this.nugetKey} --store-password-in-clear-text`
            } else {
                this.sourceType = "NuGet"
                addSourceCmd = `nuget sources add -Source ${this.nugetSource}/v3/index.json -name ${SOURCE_NAME}`
            }
        } else {
            console.log(this.nugetSource + " is already in sources.")
            console.log(this._executeCommand(`nuget sources Remove -Source ${this.nugetSource}/v3/index.json`).stdio)
            addSourceCmd = `nuget sources add -Source ${this.nugetSource}/v3/index.json -name ${SOURCE_NAME}`
        }

        console.log(this._executeCommand(addSourceCmd, { encoding: "utf-8" }))
        const enable = this._executeCommand(`nuget sources enable -Name ${SOURCE_NAME}`, { encoding: "utf8" });
        console.log(enable);

        const list1 = this._executeCommand("nuget sources list", { encoding: "utf8" });
        console.log(list1);
    }

    _printErrorAndExit(msg) {
        console.log(`##[error]😭 ${msg}`)
        throw new Error(msg)
    }

    _executeCommand(cmd, options) {
        console.log(`executing: [${cmd}]`)
        try {
            const INPUT = cmd.split(" "), TOOL = INPUT[0], ARGS = INPUT.slice(1)
            const result = spawnSync(TOOL, ARGS, options)
            if(result === undefined) {
                throw new Error(`Calling '${cmd}' resulted in undefined childProcess.`)
            }

            if(result.exitCode !== undefined && result.exitCode !== 0) {
                throw new Error(`Calling '${cmd}' resulted in${os.EOL}${result.exitCode}, ${result.stderr}`)
            }

            const output = result.stdout;

            console.log(`result: ${output}`);
            return output;
        } catch(error) {
            throw error;
        }
    }

    _executeInProcess(cmd) {
        this._executeCommand(cmd, { encoding: "utf-8", stdio: [process.stdin, process, process.stderr] })
    }

    _tagCommit(version) {
        const TAG = this.tagFormat.replace("*", version)

        console.log(`✨ creating new tag ${TAG}`)

        this._executeCommand(`git tag ${TAG}`)
        this._executeCommand(`git push origin ${TAG}`)

        console.log(`::set-output name=VERSION::${TAG}` + os.EOL)
    }

    _pushPackage(version, name) {
        console.log(`✨ found new version (${version}) of ${name}`)

        if (!this.nugetKey) {
            console.log("##[warning]😢 NUGET_KEY not given")
            return
        }

        console.log(`NuGet Source: ${this.nugetSource}`)

        if(!this.noBuild) {
            fs.readdirSync(".").filter(fn => /\.s?nupkg$/.test(fn)).forEach(fn => fs.unlinkSync(fn))

            this._executeCommand(`dotnet pack ${this.projectFile} ${this.includeSymbols ? "--include-symbols -p:SymbolPackageFormat=snupkg" : ""} -c Release -o .`)
        }
        const packages = fs.readdirSync(this.outputFolder).filter(fn => fn.endsWith("nupkg"))

        if(packages.length === 0) {
            throw Error('No packages were built.')
        }

        console.log(`Generated Package(s): ${packages.join(", ")}`)
        for (const pkg in packages) {
            const pushCmd = `nuget push ${pkg} -src ${(SOURCE_NAME)} ${this.nugetSource !== "GPR" ? `-ApiKey ${this.nugetKey}` : ""} -SkipDuplicate ${!this.includeSymbols ? "-NoSymbols" : ""}`

            const pushOutput = this._executeCommand(pushCmd, {encoding: "utf-8"})

            if (/error/.test(pushOutput))
                this._printErrorAndExit(`${/error.*/.exec(pushOutput)[0]}`)

            if (pkg.endsWith("snupkg")) {
                console.log(`::set-output name=SYMBOLS_PACKAGE_NAME::${pkg}` + os.EOL)
                console.log(`::set-output name=SYMBOLS_PACKAGE_PATH::${path.resolve(pkg)}` + os.EOL)
            } else {
                console.log(`::set-output name=PACKAGE_NAME::${pkg}` + os.EOL)
                console.log(`::set-output name=PACKAGE_PATH::${path.resolve(pkg)}` + os.EOL)
            }
        }

        if (this.tagCommit)
            this._tagCommit(version)
    }

    _checkForUpdate() {
        if (!this.packageName) {
            this.packageName = path.basename(this.projectFile).split(".").slice(0, -1).join(".")
        }

        console.log(`Package Name: ${this.packageName}`)

        let url = ""
        let options; //used for authentication

         options = {
            method: "GET"
        }
        //small hack to get package versions from Github Package Registry
        if (this.sourceType === "GPR") {
            url = `${this.nugetSource}/download/${this.packageName}/index.json`

            console.log(`This is GPR, changing url for versioning...`)
        } else {
            url = `${this.nugetSource}/v3-flatcontainer/${this.packageName}/index.json`
        }

        console.log(url, options)

        https.get(url, options, (res) => {
            console.log(`Got response: ${res}`)
            let body = ""
            
            console.log(`Status code: ${res.statusCode}: ${res.statusMessage}`)

            if (res.statusCode == 404){
                console.log(`No packages found. Pushing initial version...`)
                this._pushPackage(this.version, this.packageName)
            } 
            else if (res.statusCode == 200) {
                res.setEncoding("utf8")
                res.on("data", chunk => body += chunk)
                res.on("end", () => {
                    const existingVersions = JSON.parse(body)
                    if (existingVersions.versions.indexOf(this.version) < 0) {
                        console.log(`This version is new, pushing...`)
                        this._pushPackage(this.version, this.packageName)
                    }
                    else
                    {
                        let errorMsg = `Version ${this.version} already exists`;
                        console.log(errorMsg)
                        
                        if(this.throwOnVersionExixts) {
                            this._printErrorAndExit(`error: ${errorMsg}`)
                        }
                    }
                })
            }
            else {
               this._printErrorAndExit(`error: ${res.statusCode}: ${res.statusMessage}`)
            }
            
        }).on("error", e => {
            console.log(`Got error: ${e}`)
            this._printErrorAndExit(`error: ${e.message}`)
        })
    }

    run() {
        if(!this.NO_BUILD) {
            if (!this.projectFile || !fs.existsSync(this.projectFile)) {
                this._printErrorAndExit("project file not found")
            }

            console.log(`Project Filepath: ${this.projectFile}`)

            if (!this.version) {
                if (this.versionFile !== this.projectFile && !fs.existsSync(this.versionFile))
                    this._printErrorAndExit("version file not found")

                console.log(`Version Filepath: ${this.versionFile}`)
                console.log(`Version Regex: ${this.versionRegex}`)

                const versionFileContent = fs.readFileSync(this.versionFile, {encoding: "utf-8"}),
                    parsedVersion = this.versionRegex.exec(versionFileContent)

                if (!parsedVersion)
                    this._printErrorAndExit("unable to extract version info!")

                this.version = parsedVersion[1]
            }

            console.log(`Version: ${this.version}`)
        }

        this._checkForUpdate()
    }
}

new Action().run()
