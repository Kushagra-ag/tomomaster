'use strict'

const { Validator } = require('../models/blockchain/validator')
const db = require('../models/mongodb')
const BigNumber = require('bignumber.js')
const config = require('config')
const consumer = {}

consumer.name = 'reward'
consumer.task = async function (job, done) {
    let block = job.data.block
    let epoch = parseInt(config.get('blockchain.epoch'))
    let blockNumber = parseInt(block.number)

    if (blockNumber % epoch !== 0) {
        return done()
    }

    let validator = await Validator.deployed()

    let startBlockNumber = blockNumber - (2 * epoch) + 1
    let endBlockNumber = blockNumber - epoch
    let sn = await db.Signer.findOne({
        blockNumber: (startBlockNumber - 1)
    })

    let signers = (sn || {}).signers || []

    console.log('Reward masternodes', signers)

    let totalReward = config.get('blockchain.reward') // TOMO
    let mnRewardRate = config.get('blockchain.masternodeRewardRate')
    let vRewardRate = config.get('blockchain.voterRewardRate')
    let fdRewardRate = config.get('blockchain.foundationRewardRate')
    let fdAddress = config.get('blockchain.foundationAddress')
    let reward = []
    let totalSign = 0
    let map = signers.map(async s => {
        let ns = await db.BlockSigner.count({
            blockNumber: { $in: Array.from(new Array(epoch), (val, index) => startBlockNumber + index) },
            'signers.signer': s
        })
        reward.push({
            address: s,
            signNumber: ns
        })
        totalSign = totalSign + ns
        return ns
    })

    await Promise.all(map)

    let fdReward = new BigNumber(0)

    map = reward.map(async r => {
        let mn = new BigNumber(r.signNumber * totalReward).div(totalSign)
            .multipliedBy(1e+18)

        fdReward = fdReward.plus(mn.multipliedBy(fdRewardRate).div(100))

        let mnRewardState = {
            address: r.address,
            reward:  mn.multipliedBy(mnRewardRate).div(100).toString()
        }

        let vh = await db.VoteHistory.findOne({
            candidate: r.address,
            blockNumber: {
                $lt: blockNumber
            }
        }).sort({ blockNumber: -1 })

        let voters = vh.voters
        let candidateCap = await validator.getCandidateCap.call(r.address)
        let owner = await validator.getCandidateOwner.call(r.address)

        let vmap = voters.map(v => {
            let voterReward = mn.multipliedBy(new BigNumber(v.capacity))
                .div(candidateCap).multipliedBy(vRewardRate).div(100)
            return db.VoterReward.create({
                address: v.address,
                candidate: r.address,
                reward: voterReward.toString(),
                checkpoint: blockNumber,
                startBlockNumber: startBlockNumber,
                endBlockNumber: endBlockNumber,
                voted: v.capacity.toString(),
                signNumber: r.signNumber
            })
        })
        await Promise.all(vmap)
        return db.MnReward.create({
            address: mnRewardState.address,
            owner: owner,
            signNumber: r.signNumber,
            reward: mnRewardState.reward,
            checkpoint: blockNumber,
            startBlockNumber: startBlockNumber,
            endBlockNumber: endBlockNumber,
            totalSigners: signers.length
        })
    })

    await db.FdReward.create({
        address: fdAddress,
        reward: fdReward.toString(),
        checkpoint: blockNumber,
        startBlockNumber: startBlockNumber,
        endBlockNumber: endBlockNumber
    })

    await Promise.all(map)

    done()
}

module.exports = consumer