import * as express from 'express';
import * as fs from 'fs';
//import * as cds from '@sap/cds-dk';
import { parse, parseLines, stringify } from 'dot-properties';
const cds = require('@sap/cds-dk');

const cdsLaunchpadLogger = cds.log('cds-launchpad-plugin');
export interface LaunchpadConfig {
  version?: string,
  theme?: string,
  basePath?: string,
  appConfigPath?: string,
  locale?: string // TODO if it was possible to get sap-ui-language from request which retrieves the app config json, we wouldnt need this option
}

export class cds_launchpad_plugin{
  setup (options?: LaunchpadConfig): express.Router{
    options = options !== undefined ? options : {};
    options = options.basePath !== undefined ? options : Object.assign({ basePath:'/$launchpad' }, options);
    const router = express.Router();

    cds.on('serving', async (service) => {
      const apiPath = options.basePath;
      const mount = apiPath.replace('$','[\\$]')
      cdsLaunchpadLogger._debug && cdsLaunchpadLogger.debug ('serving launchpad for ', {service: service.name, at: apiPath})

      router.use(mount, async (request: express.Request, response: express.Response, next) => {
        response.send(await this.prepareTemplate(options));
        //next();
      });

      router.use('/appconfig/fioriSandboxConfig.json', async (request, response, next) => {
        // debugger;
        response.send(await this.prepareAppConfigJSON(options));
      });

      this.addLinkToIndexHtml(service, apiPath)
    });

    return router;
  }

  async prepareTemplate(options: LaunchpadConfig): Promise<string>{
    let url = `https://sapui5.hana.ondemand.com`;
    const theme = options.theme ? options.theme : "sap_fiori_3";
    const htmltemplate = fs.readFileSync(__dirname + '/../templates/launchpad.html').toString();

    if(options.version !== undefined && options.version !== ''){
      url = url + '/' + options.version;
    }

    return htmltemplate.replace(/LIB_URL/g, url)
                       .replace(/THEME/g, theme);
  }

  async prepareAppConfigJSON(options: LaunchpadConfig): Promise<string> {
    // Read app config template
    const config = JSON.parse(fs.readFileSync(__dirname + '/../templates/appconfig.json').toString());

    // Read externally provided config 
    const extConfig = options.appConfigPath ? JSON.parse(fs.readFileSync(options.appConfigPath).toString()) : {};

    // merge the two
    Object.assign(config, extConfig);

    // Read CDS project package
    const packagejson = JSON.parse(fs.readFileSync(cds.root + '/package.json').toString());

    // Read manifest files for each UI project that is defined in the project package
    if(Array.isArray(packagejson.sapux)){
      const applications = {};

      packagejson.sapux.forEach(element => {
        const manifest = JSON.parse(fs.readFileSync(cds.root + '/' + element + '/webapp/manifest.json' ).toString());
        const appId = manifest["sap.app"].id;

        if (manifest["sap.flp"]?.type === 'plugin') {
            const component = appId;
            const name = component.split('.').pop();
            config.bootstrapPlugins[name] = {
                component,
                url: name + "/webapp",
                'sap-ushell-plugin-type': 'RendererExtensions',
                enabled: true
            }
            return;
        }

        let i18nsetting = manifest["sap.app"].i18n;
        let i18nPath = cds.root + '/' + element + '/webapp/';
        if(typeof(i18nsetting) === "object") {
          if(manifest._version < "1.21.0") {
            cdsLaunchpadLogger.error(`manifest.json version of ${element} does not allow i18n being an object. Minumum version 1.21.0.`)
          }
          i18nPath += i18nsetting.bundleUrl;
        } else {
          i18nPath += i18nsetting;
        }

        if (options.locale) {
          i18nPath = i18nPath.replace(/(\.properties)$/,`_${options.locale}$1`);
        }
        const i18n = parse(fs.readFileSync( i18nPath ).toString());
        const tileconfigs = manifest["sap.app"]?.crossNavigation?.inbounds;

        for (const tileconfigId in tileconfigs){
          const tileconfig = tileconfigs[tileconfigId];
          const tileId = `${appId}-${tileconfigId}`;

          // Replace potential string templates used for tile title and description (take descriptions from default i18n file)
          Object.keys(tileconfig).forEach(key => {
            if(['title','subTitle','info'].includes(key)){
                const strippedValue = tileconfig[key].toString().replace(`{{`, ``).replace(`}}`, ``);
                
                if(i18n[strippedValue] !== undefined) {
                    tileconfig[key] = i18n[strippedValue];
                }
            }  
          });

          // App URL
          const url = `/${element.replace(cds.env.folders.app, '')}/webapp`;
          const component = `SAPUI5.Component=${appId}`;

          // App tile template
          config.services.LaunchPage.adapter.config.groups[0].tiles.push({
            id: tileId, 
            properties: Object.assign({ 
              targetURL: `#${tileconfig.semanticObject}-${tileconfig.action}`, 
              title: tileconfig.title,
              info: tileconfig.info,
              subtitle: tileconfig.subTitle,
              icon: tileconfig.icon
            }, tileconfig.indicatorDataSource ? {
              serviceUrl: manifest["sap.app"].dataSources[tileconfig.indicatorDataSource.dataSource].uri + tileconfig.indicatorDataSource.path
            } : {} ), 
            tileType: tileconfig.indicatorDataSource ? 'sap.ushell.ui.tile.DynamicTile' : 'sap.ushell.ui.tile.StaticTile',
            serviceRefreshInterval: (tileconfig.indicatorDataSource && tileconfig.indicatorDataSource.refresh || 10) // defautl 10 sec
            // multiplying by a large number basically means "never refresh" - this can stay this way as long as
            // its not supported by the local adapter, see sap.ushell.adapters.local.LaunchPageAdapter, private function handleTileServiceCall,
            // which does the service calls correctly and regularly, but doesnt update the tiles
            * 1000 
          });

          config.services.ClientSideTargetResolution.adapter.config.inbounds[tileId] = tileconfig;
          config.services.ClientSideTargetResolution.adapter.config.inbounds[tileId].resolutionResult = {
            "applicationType": "SAPUI5",
            "additionalInformation": component,
            "url": url
          };
        }

      });
    }

    return config;
  }

  addLinkToIndexHtml(service, apiPath: string) {
    const provider = (entity) => {
      if (entity)  return // avoid link on entity level, looks too messy
      return { href:apiPath, name:'Launchpad', title:'Fiori Launchpad' }
    }
    service.$linkProviders ? service.$linkProviders.push(provider) : service.$linkProviders = [provider]
  }
}
