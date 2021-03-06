const ethWallet = require('ethereumjs-wallet');
const ethUtil = require('ethereumjs-util');
const nacl = require('tweetnacl');
const bip39 = require('bip39');
const hdkey = require('hdkey');
const CONSTANTS = require('../constants');
const utils = require('../utils');
const kcUtils = require('./kc-utils');

nacl.util = require('tweetnacl-util');

if (typeof localStorage === 'undefined' || localStorage === null) {
  const LocalStorage = require('node-localstorage').LocalStorage;
  localStorage = new LocalStorage('./tmp');
}

class LocalStorageContainer {
  constructor(db) {
    this.prefix = CONSTANTS.KCPREFIX;
    this.type = 'localStorage';
    this.encryptionKey = '';
    this.db = db;
    this.timer = {};
  }

  /*
   * @param  {String} passphrase
   */
  unlock(passphrase) {
    // unlock key container
    this.encryptionKey = kcUtils.passToKey(passphrase, 'salt');
    const self = this;
    this.timer = setTimeout(() => {
      // key container locked again
      self.encryptionKey = '';
    }, 30000);
  }

  /**
   * Lock local storage container
   */
  lock() {
    if (!this.encryptionKey) {
      console.error('Error: KeyContainer not unlocked');
      return;
    }
    const self = this;
    clearTimeout(this.timer);
    // key container locked
    self.encryptionKey = '';
  }

  /**
   * Check if local storage container is unlocked
   * @returns {Bool} - Lock / unlock
   */
  isUnlock() {
    if (this.encryptionKey) {
      return true;
    }
    return false;
  }

  /**
   * Save a given { key - value } pair
   * @param {String} - Key
   * @param {Object} - Value
   * @returns {Bool} - True if databe has been written correctly, False otherwise
   */
  saveObject(key, value) {
    try {
      this.db.insert(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Store the master seed into database as a mnemonic
   * If no master seed is provided, it generates a random one
   * @param {String} mnemonic - Mnemonic to store
   * @returns {Bool} - True if database has been written correctly, False otherwise
   */
  generateMasterSeed(mnemonic = bip39.generateMnemonic()) {
    if (this.isUnlock() && bip39.validateMnemonic(mnemonic)) {
      this.saveMasterSeed(mnemonic);
      return true;
    }
    return false;
  }

  /**
   * Encrypts a string and store it under masterSeed label
   * @param {String} masterSeed - Mnemonic to store
   * @returns {Bool} - True if database has been written correctly, False otherwise
   */
  saveMasterSeed(masterSeed) {
    const seedEncrypted = kcUtils.encrypt(this.encryptionKey, masterSeed);

    this.db.insert(`${this.prefix}masterSeed`, seedEncrypted);
  }

  /**
   * Get master seed from database in a mnemonic form
   * @param {String} pass - Passphrase enter by the user
   * @returns {String} Mnemonic representing the master seed
   */
  getMasterSeed(pass = this.encryptionKey) {
    if (this.isUnlock()) {
      const seedKey = this.db.listKeys(`${this.prefix}masterSeed`);
      let mnemonic = '';

      if (seedKey.length === 0) {
        return undefined;
      }
      const seedEncrypted = this.db.get(seedKey);
      try {
        mnemonic = kcUtils.decrypt(pass, seedEncrypted);
      } catch (error) {
        return undefined;
      }
      return mnemonic;
    }
    return undefined;
  }

  /**
   * Creates all the keys needed to create an identity afterwards
   * @returns {Object} - It contains all the keys generated, undefined otherwise
   */
  createKeys() {
    if (this.isUnlock()) {
      let objectKeySeed;
      // Get key seed and generate it, if it is not already created
      objectKeySeed = this.getKeySeed();
      // Generate key seed if it does not exist
      if (objectKeySeed === undefined) {
        if (this.generateKeySeed(this.getMasterSeed())) {
          objectKeySeed = this.getKeySeed();
        }
      }
      // Creates keys
      const { keys } = this.generateKeysFromKeyPath(objectKeySeed.keySeed, objectKeySeed.pathKey);

      this.increaseKeyPath();
      return keys;
    }
    return undefined;
  }

  /**
   * Generates identity seed and store it into the database along with its current path
   * @param {String} masterSeed - Master seed represented as a mnemonic
   * @return {Bool} - Acknowledge
   */
  generateKeySeed(masterSeed) {
    if (this.isUnlock()) {
      const root = hdkey.fromMasterSeed(masterSeed);
      const pathRoot = "m/44'/60'/0'";
      // Identity master generation
      const nodeId = root.derive(pathRoot);
      const privKey = nodeId._privateKey;
      const keySeed = bip39.entropyToMnemonic(privKey);
      const keySeedEncrypted = kcUtils.encrypt(this.encryptionKey, keySeed);
      const pathKey = Buffer.alloc(4);
      pathKey.writeUInt32BE(0);
      const pathKeySeedEncrypted = kcUtils.encrypt(this.encryptionKey, utils.bytesToHex(pathKey));

      this.db.insert(`${this.prefix}keySeed`, JSON.stringify({ keySeedEncrypted, pathKeySeedEncrypted }));
      return true;
    }
    return false;
  }

  /**
   * Gets key chain and its current path
   * @return {Object} - Contains key chain and its current path
   */
  getKeySeed() {
    if (this.isUnlock()) {
      const keySeedDb = this.db.listKeys(`${this.prefix}keySeed`);

      if (keySeedDb.length === 0) {
        return undefined;
      }
      const { keySeedEncrypted, pathKeySeedEncrypted } = JSON.parse(this.db.get(keySeedDb));
      const keySeed = kcUtils.decrypt(this.encryptionKey, keySeedEncrypted);
      const pathKeySeed = kcUtils.decrypt(this.encryptionKey, pathKeySeedEncrypted);
      const pathKey = (utils.hexToBytes(pathKeySeed)).readUInt32BE();
      return { keySeed, pathKey };
    }
    return undefined;
  }

  /**
   * Increase one level on key chain path
   * @return {Bool} - Acknowledge
   */
  increaseKeyPath() {
    if (this.isUnlock()) {
      const { keySeed, pathKey } = this.getKeySeed();
      const increasePathKey = pathKey + 1;
      const pathKeyDb = Buffer.alloc(4);
      pathKeyDb.writeUInt32BE(increasePathKey);
      const keySeedEncrypted = kcUtils.encrypt(this.encryptionKey, keySeed);
      const pathKeySeedEncrypted = kcUtils.encrypt(this.encryptionKey, utils.bytesToHex(pathKeyDb));

      this.db.insert(`${this.prefix}keySeed`, JSON.stringify({ keySeedEncrypted, pathKeySeedEncrypted }));
      return true;
    }
    return false;
  }

  /**
   * Generates recovery seed and store it into the database
   * @param {String} masterSeed - Master seed representes as a memonic
   * @return {String} - Public recovery address
   */
  generateRecoveryAddr(masterSeed) {
    if (this.isUnlock()) {
      const root = hdkey.fromMasterSeed(masterSeed);
      const pathRecovery = "m/44'/60'/1'";
      const addrNodeRecovery = root.derive(pathRecovery);
      const privRecovery = addrNodeRecovery._privateKey;
      const addressRecovery = ethUtil.privateToAddress(privRecovery);
      const addressRecoveryHex = utils.bytesToHex(addressRecovery);
      const privRecoveryHex = utils.bytesToHex(privRecovery);
      const privRecoveryHexEncrypted = kcUtils.encrypt(this.encryptionKey, privRecoveryHex);

      this.db.insert(this.prefix + CONSTANTS.IDRECOVERYPREFIX + addressRecoveryHex, privRecoveryHexEncrypted);
      return addressRecoveryHex;
    }
    return undefined;
  }

  /**
   * Generates a key from a given key chain and its path
   * Key is stored as: { 'public address': 'encrypted(private key)' }
   * @param {Number} keyChainPath - First path to derive the key
   * @param {Number} keyPath - Second path to derive the key
   * @returns {String} Public address key generated
   */
  generateSingleKey(keyProfilePath, keyPath) {
    if (this.isUnlock()) {
      const path = `m/44'/60'/0'/${keyProfilePath}/${keyPath}`;
      const { keySeed } = this.getKeySeed();
      const root = hdkey.fromMasterSeed(keySeed);
      const addrNode = root.derive(path);
      const privK = addrNode._privateKey;
      const address = ethUtil.privateToAddress(addrNode._privateKey);
      const addressHex = utils.bytesToHex(address);
      const privKHex = utils.bytesToHex(privK);
      const privKHexEncrypted = kcUtils.encrypt(this.encryptionKey, privKHex);

      this.db.insert(this.prefix + addressHex, privKHexEncrypted);
      return addressHex;
    }
    return undefined;
  }

  /**
   * Gets recovery address from the data base
   * @return {String} - Recovery public address
   */
  getRecoveryAddr() {
    if (this.isUnlock()) {
      const idSeedKey = this.db.listKeys(this.prefix + CONSTANTS.IDRECOVERYPREFIX);

      if (idSeedKey.length === 0) {
        return undefined;
      }
      return idSeedKey[0].replace(this.prefix + CONSTANTS.IDRECOVERYPREFIX, '');
    }
    return undefined;
  }

  /**
   * @param  {String} mnemonic - String with 12 words
   * @param {Number} pathProfile - Indicates the penultimate layer of the derivation path, for the different identity profiles
   * @param  {Number} numberOfDerivatedKeys - Indicates the last layer of the derivation path, for the different keys of the identity profile
   * @returns {Object} It contains all the keys generated
   */
  generateKeysFromKeyPath(mnemonic = bip39.generateMnemonic(), pathProfile = 0, numberOfDerivedKeys = 3) {
    if (!this.isUnlock() || !bip39.validateMnemonic(mnemonic)) {
      console.error('Error: KeyContainer not unlocked');
      return undefined;
    }
    const root = hdkey.fromMasterSeed(mnemonic);
    const keys = [];
    const path = "m/44'/60'/0'/";

    // to allow in the future specify how many keys want to derivate
    for (let i = 0; i < numberOfDerivedKeys; i++) {
      const addrNode = root.derive(`${path + pathProfile}/${i}`); // "m/44'/60'/0'/pathProfile/i"
      const privK = addrNode._privateKey;
      const address = ethUtil.privateToAddress(addrNode._privateKey);
      const addressHex = utils.bytesToHex(address);
      const privKHex = utils.bytesToHex(privK);
      const privKHexEncrypted = kcUtils.encrypt(this.encryptionKey, privKHex);
      keys.push(addressHex);

      this.db.insert(this.prefix + addressHex, privKHexEncrypted);
      // Consider key 0 as the operational
      // Retrieve and save public key ( compress format ) from private operational
      if (i === 0) {
        const pubK = addrNode._publicKey;
        const pubKHex = utils.bytesToHex(pubK);
        keys.push(pubKHex);

        this.db.insert(this.prefix + pubKHex, privKHexEncrypted);
      }
    }
    return { keys };
  }

  /**
   * Get all the identities from dataBase
   * @returns {Array} Contains all the identities found in the database
   */
  listIdentities() {
    const idList = [];
    const localStorageLength = localStorage.length;
    for (let i = 0, len = localStorageLength; i < len; i++) {
      // get only the stored data related to identities (that have the prefix)
      if (localStorage.key(i).indexOf(this.db.prefix + this.prefix + CONSTANTS.IDPREFIX) !== -1) {
        const identity = localStorage.key(i).replace(this.prefix + this.db.prefix, '');

        idList.push(identity);
      }
    }
    return idList;
  }

  /**
   * @returns {String} AddressHex
   */
  generateKeyRand() {
    if (!this.encryptionKey) {
      // KeyContainer not unlocked
      console.error('Error: KeyContainer not unlocked');
      return undefined;
    }
    const w = ethWallet.generate();
    const privK = w._privKey;
    const address = ethUtil.privateToAddress(privK);
    const addressHex = utils.bytesToHex(address);
    const privKHex = utils.bytesToHex(privK);
    const privKHexEncrypted = kcUtils.encrypt(this.encryptionKey, privKHex);

    this.db.insert(this.prefix + addressHex, privKHexEncrypted);
    return addressHex;
  }

  /**
   * @param {String} privKHex - PrivK
   *
   * @returns {String} AddressHex
   */
  importKey(privKHex) {
    if (!this.encryptionKey || privKHex.constructor !== String) {
      // KeyContainer not unlocked
      console.error('Error: KeyContainer not unlocked');
      return undefined;
    }
    const privK = utils.hexToBytes(privKHex);
    const address = ethUtil.privateToAddress(privK);
    const addressHex = utils.bytesToHex(address);
    const privKHexEncrypted = kcUtils.encrypt(this.encryptionKey, privKHex);

    // localStorage.setItem(this.prefix + addressHex, privKHexEncrypted);
    this.db.insert(this.prefix + addressHex, privKHexEncrypted);
    return addressHex;
  }

  /**
   * @param  {String} addressHex
   * @param  {String} data
   *
   * @returns {Object} signatureObj
   */
  sign(addressHex, data) {
    if (!this.encryptionKey) {
      // KeyContainer not unlocked
      console.error('Error: KeyContainer not unlocked');
      return 'KeyContainer blocked';
    }
    // const privKHexEncrypted = localStorage.getItem(this.prefix + addressHex);
    const privKHexEncrypted = this.db.get(this.prefix + addressHex);
    const message = ethUtil.toBuffer(data);
    const msgHash = ethUtil.hashPersonalMessage(message);
    const privKHex = kcUtils.decrypt(this.encryptionKey, privKHexEncrypted);
    const sig = ethUtil.ecsign(msgHash, utils.hexToBytes(privKHex));

    return kcUtils.concatSignature(message, msgHash, sig.v, sig.r, sig.s);
  }

  /**
   * @returns {Array}
   */
  listKeys() {
    const keysList = [];
    const localStorageLength = localStorage.length;

    for (let i = 0, len = localStorageLength; i < len; i++) {
      // get only the stored data related to keycontainer (that have the prefix)
      if (localStorage.key(i).indexOf(this.prefix + this.db.prefix) !== -1) {
        const key = localStorage.key(i).replace(this.prefix + this.db.prefix, '');
        keysList.push(key);
      }
    }

    return keysList;
  }

  /**
   * @param  {String} addressHex
   */
  deleteKey(addressHex) {
    // localStorage.removeItem(this.prefix + addressHex);
    this.db.delete(this.prefix + addressHex);
  }

  deleteAll() {
    // localStorage.clear();
    this.db.deleteAll();
  }

  encrypt(m) {
    if (!this.encryptionKey) {
      console.error('Error: KeyContainer not unlocked');
      return undefined;
    }
    return kcUtils.encrypt(this.encryptionKey, m);
  }

  decrypt(c) {
    if (!this.encryptionKey) {
      console.error('Error: KeyContainer not unlocked');
      return undefined;
    }
    return kcUtils.decrypt(this.encryptionKey, c);
  }
}

module.exports = LocalStorageContainer;
