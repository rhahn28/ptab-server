const { survivalStatus } = require('../../config/config.json');

const binClaims = (client, collection, chartID, userID) => {
  // bins all elements in collection into
  // [6_unbinned, 5_killed, 4_impaired, 3_weakened, 2_unaffected]
  // 1. intersect collection with each of the survivalList entries
  // 2. create ID patent:claim ZLISTS for each intersection
  // 2.1 for each bin, get the list and map it to hmget Patent Claim
  // returns a multi-line string indicating the number of items in each bin 
  // of the newly-created ZLISTS
  const namespace = `user${userID}:chart${chartID}`;

  return client.keys(`${namespace}:index`)
    .then(result => {
      // console.log(result.length);
      // if there is an index, delete all of the members so we can start fresh
      return result.length !== 0 ? client.smembers(`${namespace}:index`) : 0
    })
    .then(listing => {
      // console.log(listing);
      listing !== 0 ? client.del(...listing, `${namespace}:index`) : 0
    })
    .then(() => {
      // store the intersection of chartID:all:(each bin) - the partial collection 
      // with survivalList (the whole collection)
      // add the new intersection set to the index and return the members of the sets
      const cmdList = [].concat(...survivalStatus.map(bin => {
        if (collection === 'all') {
          // for the 'all' collection, instead of intersecting we just move the 'survivalList'
          // over untouched and return its members for further normalization
          return [
            ['sunionstore', `${namespace}:all:${bin}`, `survivalList:${bin}`],
            ['expire', `${namespace}:all:${bin}`, 3600],
            ['sadd', `${namespace}:index`, `${namespace}:all:${bin}`],
            ['expire', `${namespace}:index`, 3600],
            ['smembers', `${namespace}:all:${bin}`]
          ]
        } else {
          return [
            ['sinterstore', `${namespace}:all:${bin}`, `survivalList:${bin}`, collection],
            ['expire', `${namespace}:all:${bin}`, 3600],
            ['sadd', `${namespace}:index`, `${namespace}:all:${bin}`],
            ['expire', `${namespace}:index`, 3600],
            ['smembers', `${namespace}:all:${bin}`]
          ]
        }
      })
      )
      return client.multi(cmdList).exec()
    })
    .then(results => {
      // now have an array of 25 items, 5 for each bin type
      // of the form 1, 1, 1, 1, <array>
      // pick off the arrays (every 5th item) into a command list
      const hgetCmd = results.reduce((accum, item, index) => {
        if ((index + 1) % 5 === 0) accum.push(item);
        return accum;
      }, []);
      console.log('converting user %s chart %d to patent:claim list', userID, chartID);
      // the result array contains [results], 1 or 0, [results], 1 or 0, so filter it down to just results 
      return Promise.all(hgetCmd.map((resultSet, index) => {
        return client.multi(resultSet.map(item => ['hmget', item, 'ID', 'Patent', 'Claim'])).exec()
          .then(zresults => {
            // so for each element there is a large array of [ID, Patent, Claim]
            // but a few may be undefined, if there were no matches
            // console.log('chart%d: %d elements extracted from %s', chartID, zresults.length, survivalStatus[index]);
            const zCmdList = [].concat(...zresults.map(result => {
              if (result.length === 3) {
                return [
                  ['zadd', `${namespace}:${survivalStatus[index]}`, result[0], `${result[1]}:${result[2]}`],
                  ['expire', `${namespace}:${survivalStatus[index]}`, 3600]
                ]
              } else {
                return [
                  ['zadd', `${namespace}:${survivalStatus[index]}`],
                  ['expire', `${namespace}:${survivalStatus[index]}`, 3600]
                ]
              }
            }));
            // add non-empty sets to the index
            if (resultSet.length !== 0) {
              zCmdList.push(['sadd', `${namespace}:index`, `${namespace}:${survivalStatus[index]}`]);
            }
            // console.log('executing new query %j')
            return client.multi(zCmdList).exec()
          })
      }))
    })
    .then(result => {
      //result.pop();
      // TODO: danger, not sure what will happen if a set is skipped !!
      const resultCount = result.filter(item => item !== 1 && item !== 0).map((item, index) => { return { bin: survivalStatus[index], count: item.reduce((sum, val) => sum += val, 0) } });
      console.log(resultCount.map(item => `${namespace}: ${item.count} patent/claim combinations added to ${item.bin}`).join('\n'));
      return Promise.resolve(resultCount);
    })
    .catch(err => Promise.reject(err))
}


// deDup - removes overlaps between bins and preserves only the worst outcome
// @param client = redis.client
// @param chartID = number, the number of the chart
// @param checkArray = array<survival bins> - the survival status values
// returns string 'chartID${chartID}'

const deDup = (client, chartID, userID) => {
  const checkArray = survivalStatus.slice().reverse();
  const end = checkArray.length;
  let survivalUnique = [];
  const namespace = `user${userID}:chart${chartID}`;
  // console.log('de-duplicating user %s chart %s', userID, chartID);
  // optimized way to only ensure the worst case status is kept and duplicates removed
  return Promise.all(checkArray.map((current, index, input) => {
    // console.log('processing element %d, value %s, total length %d', index, current, end)
    const intersect = (intIdx) => {
      // currently the indexing calls itself, so short-circuit that one
      if (intIdx === index) return Promise.resolve(intIdx + 1);
      // console.log('intersecting %s with %s', checkArray[index], checkArray[intIdx]);
      // now the loop - intersect, add to index, get the contents of the intersection
      return client.multi()
        .zinterstore(`${namespace}:${checkArray[index]}_${checkArray[intIdx]}`, 2, `${namespace}:${checkArray[index]}`, `${namespace}:${checkArray[intIdx]}`)
        .expire(`${namespace}:${checkArray[index]}_${checkArray[intIdx]}`, 3600)
        .zrange(`${namespace}:${checkArray[index]}_${checkArray[intIdx]}`, 0, -1)
        .exec()
        .then(result => {
          // take the last element of the result, which is the list of overlapping items
          // and remove those from the lower-numbered set. Some may be empty (no overlaps) so skip those
          // add any created table to the index
          // console.log(result);
          const overlaps = result.pop();
          // console.log('chart%d: %d intersections found between %s and %s', chartID, result[0], checkArray[index], checkArray[intIdx]);
          return result[0] > 0
            ? client.multi([
              ['sadd', `${namespace}:index`, `${namespace}:${checkArray[index]}_${checkArray[intIdx]}`],
              ['zrem', `${namespace}:${checkArray[intIdx]}`, overlaps]
            ]).exec()
            : 'skipped'
        })
        .then(result => {
          // console.log(result);
          return Promise.resolve(intIdx + 1)
        })
        .catch(err => Promise.reject(err))
    }

    const check = (checkIdx) => {
      //console.log('check called on %d / %d', index, end);
      // checks to see if we are at the end of the array of bins
      return (checkIdx === end);
    }

    const cycle = (intersect, check, cycleIdx, isDone = false) => {
      // console.log('cycle called on %s,index %d', checkArray[cycleIdx], cycleIdx)
      if (isDone) return 'done';
      return intersect(cycleIdx).then(nextIdx => cycle(intersect, check, nextIdx, check(nextIdx)))
    }
    return cycle(intersect, check, index);
  }))
    .then(() => client.multi(survivalStatus.map(item => ['zcard', `${namespace}:${item}`])).exec())
    .then(results => {
      // console.log('%j unique claims added', numUnique);
      survivalUnique = results.map((count, index) => {
        return { type: survivalStatus[index], count }
      })
      return Promise.resolve(survivalUnique)
    })
    .catch(err => Promise.reject(err))
}

// allClaims returns a the total and binned count of claims without any normalization.

const allClaims = (client, scope) => {
  let count = 0;
  return client.multi(scope).exec()
    .then(result => {
      const keyList = result.pop();
      console.log('%d keys found in %s including all duplicates', keyList.length, scope);
      // otherwise we already have this data available
      count = keyList.length;
      return client.multi(keyList.map(item => ['hget', item, 'survivalStatus'])).exec();
    })
    .then(allList => {
      // count up the number in each bin before de-duplication
      return survivalStatus.map(type => {
        const typecount = allList.filter(listVal => listVal === type).length;
        return { type, count: typecount }
      })
    })
    .then(result => Promise.resolve({ count, result }))
    .catch(err => Promise.reject(err))
}


// survivalAnalysis returns an object of {totalClaims, uniqueClaims, survivalUnique, survivalTotal}
// totalClaims is the total number of claims in scope. 
// uniqueClaims is the number of unique claims in scope.
// survival is an array of the count of unique claims in each survival bin, after de-duplication.
// @param client: redis client
// @param scope: a particular search space (eg 'patentowner:npe'), or 'all'

const survivalAnalysis = (client, scope, chartID, userID) => {
  let returnData = {};
  const scopeCmd = scope === 'all' ? [['keys', 'claimID:*']] : [['smembers', scope]];
  returnData.title = scope;
  return allClaims(client, scopeCmd)
    .then(totals => {
      returnData.countTotal = totals.count;
      returnData.survivalTotal = totals.result;
      return ('done');
    })
    .then(() => binClaims(client, scope, chartID, userID))
    .then(() => deDup(client, chartID, userID))
    .then(unique => {
      returnData.survivalUnique = unique;
      returnData.countUnique = unique.reduce((sum, item) => sum += item.count, 0);
      return Promise.resolve(returnData);
    })
    .catch(err => Promise.reject(err))
}

module.exports = {
  survivalAnalysis,
  binClaims,
  deDup,
  allClaims
}