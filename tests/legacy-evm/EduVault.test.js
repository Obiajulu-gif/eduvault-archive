const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("EduVault (archived legacy EVM prototype)", function () {
  async function deployVault() {
    const [creator, buyer, receiver, ...others] = await ethers.getSigners();
    const EduVault = await ethers.getContractFactory("EduVault");
    const vault = await EduVault.deploy();
    await vault.waitForDeployment();

    return { buyer, creator, others, receiver, vault };
  }

  function tokenIds(values) {
    return values.map((value) => Number(value));
  }

  describe("minting", function () {
    it("mints a token and stores its tokenURI", async function () {
      const { creator, vault } = await deployVault();
      const uri = "ipfs://eduvault/material-1";

      await vault.connect(creator).mint(uri);

      assert.equal(await vault.ownerOf(0), creator.address);
      assert.equal(await vault.tokenURI(0), uri);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
    });

    it("mints multiple tokens with sequential IDs", async function () {
      const { creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      await vault.connect(creator).mint("ipfs://eduvault/material-2");
      await vault.connect(creator).mint("ipfs://eduvault/material-3");

      assert.equal(await vault.ownerOf(0), creator.address);
      assert.equal(await vault.ownerOf(1), creator.address);
      assert.equal(await vault.ownerOf(2), creator.address);
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(creator.address)),
        [0, 1, 2]
      );
      assert.equal(Number(await vault.totalMinted()), 3);
    });

    it("allows different users to mint independently", async function () {
      const { creator, buyer, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      await vault.connect(buyer).mint("ipfs://eduvault/material-2");

      assert.equal(await vault.ownerOf(0), creator.address);
      assert.equal(await vault.ownerOf(1), buyer.address);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [1]);
    });
  });

  describe("transfers", function () {
    it("updates owner token enumeration after transfers", async function () {
      const { buyer, creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);

      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [0]);
      assert.equal(await vault.ownerOf(0), buyer.address);
    });

    it("handles repeated transfers correctly", async function () {
      const { buyer, creator, receiver, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      
      // Transfer to buyer
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [0]);

      // Transfer to receiver
      await vault.connect(buyer).transferFrom(buyer.address, receiver.address, 0);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(receiver.address)), [0]);

      // Transfer back to creator
      await vault.connect(receiver).transferFrom(receiver.address, creator.address, 0);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(receiver.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
    });

    it("maintains correct enumeration with multiple tokens and transfers", async function () {
      const { buyer, creator, vault } = await deployVault();

      // Creator mints 3 tokens
      await vault.connect(creator).mint("ipfs://material-1");
      await vault.connect(creator).mint("ipfs://material-2");
      await vault.connect(creator).mint("ipfs://material-3");

      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(creator.address)),
        [0, 1, 2]
      );

      // Transfer middle token (1) to buyer
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 1);
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(creator.address)).sort(),
        [0, 2]
      );
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [1]);

      // Transfer first token (0) to buyer
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [2]);
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(buyer.address)).sort(),
        [0, 1]
      );
    });

    it("handles safeTransferFrom correctly", async function () {
      const { buyer, creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      await vault.connect(creator).safeTransferFrom(creator.address, buyer.address, 0);

      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [0]);
      assert.equal(await vault.ownerOf(0), buyer.address);
    });
  });

  describe("edge cases", function () {
    it("handles transfers to and from zero-address correctly", async function () {
      const { creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");
      
      // Verify token exists and is owned by creator
      assert.equal(await vault.ownerOf(0), creator.address);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);

      // Attempting to transfer to zero address should revert in ERC721
      await assert.rejects(
        vault.connect(creator).transferFrom(creator.address, ethers.ZeroAddress, 0),
        /ERC721InvalidReceiver/
      );

      // Creator should still own the token
      assert.equal(await vault.ownerOf(0), creator.address);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
    });

    it("prevents transfer of non-existent token", async function () {
      const { buyer, creator, vault } = await deployVault();

      await assert.rejects(
        vault.connect(creator).transferFrom(creator.address, buyer.address, 999),
        /ERC721NonexistentToken/
      );
    });

    it("prevents unauthorized transfers", async function () {
      const { buyer, creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");

      await assert.rejects(
        vault.connect(buyer).transferFrom(creator.address, buyer.address, 0),
      );

      // Creator should still own the token
      assert.equal(await vault.ownerOf(0), creator.address);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
    });

    it("handles rapid successive transfers of same token", async function () {
      const { buyer, creator, others, receiver, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://eduvault/material-1");

      // Rapid transfers
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);
      await vault.connect(buyer).transferFrom(buyer.address, receiver.address, 0);
      await vault.connect(receiver).transferFrom(receiver.address, others[0].address, 0);

      assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(receiver.address)), []);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(others[0].address)), [0]);
      assert.equal(await vault.ownerOf(0), others[0].address);
    });

    it("maintains invariants after multiple mints and transfers", async function () {
      const { buyer, creator, others, receiver, vault } = await deployVault();

      // Multiple users mint tokens
      await vault.connect(creator).mint("ipfs://m1");
      await vault.connect(creator).mint("ipfs://m2");
      await vault.connect(buyer).mint("ipfs://m3");
      await vault.connect(buyer).mint("ipfs://m4");
      await vault.connect(others[0]).mint("ipfs://m5");

      // Verify initial state
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(creator.address)),
        [0, 1]
      );
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(buyer.address)),
        [2, 3]
      );
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(others[0].address)),
        [4]
      );

      // Perform various transfers
      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);
      await vault.connect(buyer).transferFrom(buyer.address, receiver.address, 2);
      await vault.connect(others[0]).transferFrom(others[0].address, creator.address, 4);

      // Verify final state
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(creator.address)).sort(),
        [1, 4]
      );
      assert.deepEqual(
        tokenIds(await vault.tokensOfOwner(buyer.address)).sort(),
        [0, 3]
      );
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(receiver.address)), [2]);
      assert.deepEqual(tokenIds(await vault.tokensOfOwner(others[0].address)), []);

      // Verify ownership via ownerOf
      assert.equal(await vault.ownerOf(0), buyer.address);
      assert.equal(await vault.ownerOf(1), creator.address);
      assert.equal(await vault.ownerOf(2), receiver.address);
      assert.equal(await vault.ownerOf(3), buyer.address);
      assert.equal(await vault.ownerOf(4), creator.address);
    });
  });

  describe("totalMinted", function () {
    it("returns correct count after multiple mints", async function () {
      const { creator, buyer, vault } = await deployVault();

      assert.equal(Number(await vault.totalMinted()), 0);

      await vault.connect(creator).mint("ipfs://m1");
      assert.equal(Number(await vault.totalMinted()), 1);

      await vault.connect(buyer).mint("ipfs://m2");
      assert.equal(Number(await vault.totalMinted()), 2);

      await vault.connect(creator).mint("ipfs://m3");
      assert.equal(Number(await vault.totalMinted()), 3);
    });

    it("totalMinted is not affected by transfers", async function () {
      const { buyer, creator, vault } = await deployVault();

      await vault.connect(creator).mint("ipfs://m1");
      await vault.connect(creator).mint("ipfs://m2");
      assert.equal(Number(await vault.totalMinted()), 2);

      await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);
      assert.equal(Number(await vault.totalMinted()), 2);
    });
  });
});
